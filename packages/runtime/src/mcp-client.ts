import { spawn, type ChildProcess } from 'node:child_process';
import type { McpServerSpec, McpTransport } from './mcp.js';
import { takeLines } from './protocol.js';

/**
 * A Model Context Protocol client, so an instance can attach its own servers to
 * a run and the model gets their tools beside the built-in ones.
 *
 * Hand-written rather than taken from the reference SDK, for the same reason
 * `companion mcp` is: what we use of the protocol is JSON-RPC 2.0 with three
 * methods, and both halves of it now live in this repository rather than in a
 * dependency whose release cadence would decide when a runner can be rebuilt.
 *
 * This file is deliberately free of the AI SDK. The daemon checks a server from
 * here when an operator saves one, and the tool adapter that does depend on the
 * SDK lives beside the agent loop that needs it.
 *
 * Everything a server returns — its tool names, its descriptions, its results —
 * is UNTRUSTED input authored by a third party and placed into a model's
 * context. Nothing about connecting a server makes what it says a directive.
 */

/**
 * What we ask for. A server answers with a version it can speak, and the
 * negotiated one is echoed on every later HTTP request because the transport
 * requires it. We accept whatever it names rather than refusing: this is the
 * client of an ecosystem, and the three methods we use have not changed across
 * any published revision.
 */
const PROTOCOL_VERSION = '2025-06-18';

export const MCP_CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 120_000;
/** A tool list that pages forever is a server bug we refuse to page along with. */
const MAX_TOOL_PAGES = 20;

const CLIENT_INFO = { name: 'companion', title: 'Companion', version: '1' } as const;

export interface McpToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

interface Transport {
  request(method: string, params: unknown, timeoutMs: number): Promise<Record<string, unknown>>;
  /**
   * Awaited, even though a notification has no reply. On HTTP each frame is its
   * own POST, so a fire-and-forget `initialized` races the `tools/list` that
   * follows it, and a server that refuses work before it is initialised — ours
   * does — would answer "Server not initialized" perhaps one time in ten.
   */
  notify(method: string, params: unknown): Promise<void>;
  close(): void;
}

// ---------- transports ---------------------------------------------------------

/** One JSON-RPC exchange in flight, keyed by the id we minted for it. */
interface Pending {
  resolve(value: Record<string, unknown>): void;
  reject(reason: Error): void;
}

/**
 * A server started as a subprocess, framed newline-delimited on its stdio.
 *
 * It inherits no environment beyond what it was declared with plus the two
 * variables any program needs to run at all. The daemon's own environment holds
 * this instance's secrets, and handing all of it to an operator-configured
 * binary would make attaching a server the widest grant in the product.
 */
class StdioTransport implements Transport {
  private readonly proc: ChildProcess;
  private readonly pending = new Map<number, Pending>();
  private buffer = '';
  private stderrTail = '';
  private nextId = 0;
  private failure: string | null = null;

  constructor(transport: Extract<McpTransport, { kind: 'stdio' }>) {
    this.proc = spawn(transport.command, [...transport.args], {
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...transport.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout?.setEncoding('utf8');
    this.proc.stdout?.on('data', (chunk: string) => {
      this.buffer = takeLines(this.buffer + chunk, (line) => this.onLine(line));
    });
    this.proc.stderr?.setEncoding('utf8');
    // Drained rather than ignored: a server whose stderr nobody reads blocks on
    // a full pipe, which presents as a tool call that never returns.
    this.proc.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2_000);
    });
    const fail = (reason: string): void => {
      this.failure ??= reason;
      for (const [, pending] of this.pending) pending.reject(new Error(reason));
      this.pending.clear();
    };
    // A child or a pipe emitting `error` with nothing listening throws on the
    // process itself, so one bad server command would take the runtime down.
    this.proc.on('error', (err) => fail(err.message));
    this.proc.stdin?.on('error', (err) => fail(err.message));
    this.proc.once('exit', (code) =>
      fail(`the server exited (${code ?? 'signal'}) ${this.stderrTail.slice(-300)}`.trim()),
    );
  }

  private onLine(line: string): void {
    let frame: { id?: unknown; result?: unknown; error?: { message?: unknown } };
    try {
      frame = JSON.parse(line) as typeof frame;
    } catch {
      return; // a server's stray log line must not stop the stream
    }
    if (typeof frame.id !== 'number') return; // a notification, or a request to us
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    if (frame.error) pending.reject(new Error(String(frame.error.message ?? 'the server reported an error')));
    else pending.resolve(asRecord(frame.result));
  }

  async request(method: string, params: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
    if (this.failure) throw new Error(this.failure);
    const id = ++this.nextId;
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (reason) => {
          clearTimeout(timer);
          reject(reason);
        },
      });
      this.proc.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async notify(method: string, params: unknown): Promise<void> {
    // One ordered pipe, so writing it is already enough to order it.
    this.proc.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  close(): void {
    this.proc.stdin?.end();
    this.proc.kill('SIGTERM');
    setTimeout(() => this.proc.kill('SIGKILL'), 2_000).unref();
  }
}

/**
 * A server reached over Streamable HTTP: one POST per request, the reply either
 * a JSON body or an SSE stream carrying it.
 *
 * The stream is read incrementally and abandoned as soon as our own id comes
 * back. A server is entitled to hold that connection open afterwards, and
 * reading it to completion would turn every call into a wait for a stream with
 * nothing left to say.
 */
class HttpTransport implements Transport {
  private sessionId: string | null = null;
  private negotiated = PROTOCOL_VERSION;
  private nextId = 0;
  private readonly aborters = new Set<AbortController>();

  constructor(private readonly transport: Extract<McpTransport, { kind: 'http' }>) {}

  /** The negotiated version is required on every request after `initialize`. */
  useProtocol(version: string): void {
    this.negotiated = version;
  }

  private headers(): Record<string, string> {
    return {
      ...this.transport.headers,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': this.negotiated,
      ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
    };
  }

  async request(method: string, params: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
    const id = ++this.nextId;
    const aborter = new AbortController();
    this.aborters.add(aborter);
    const timer = setTimeout(() => aborter.abort(), timeoutMs);
    timer.unref();
    try {
      const response = await fetch(this.transport.url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: aborter.signal,
      });
      const session = response.headers.get('mcp-session-id');
      if (session) this.sessionId = session;
      if (!response.ok) throw new Error(`the server answered ${response.status} to ${method}`);
      const frame = (response.headers.get('content-type') ?? '').includes('text/event-stream')
        ? await readEventStream(response, id)
        : (JSON.parse(await response.text()) as Record<string, unknown>);
      const error = frame.error as { message?: unknown } | undefined;
      if (error) throw new Error(String(error.message ?? 'the server reported an error'));
      return asRecord(frame.result);
    } finally {
      clearTimeout(timer);
      this.aborters.delete(aborter);
    }
  }

  /**
   * Awaited so the next request cannot overtake it. A failure is swallowed: a
   * server that ignores the notification is still a server we can talk to, and
   * refusing to connect over it would be stricter than the protocol is.
   */
  async notify(method: string, params: unknown): Promise<void> {
    await fetch(this.transport.url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
      signal: AbortSignal.timeout(MCP_CONNECT_TIMEOUT_MS),
    }).catch(() => undefined);
  }

  close(): void {
    for (const aborter of this.aborters) aborter.abort();
    this.aborters.clear();
  }
}

/** Read an SSE body until the frame carrying `id` arrives, then stop reading. */
async function readEventStream(response: Response, id: number): Promise<Record<string, unknown>> {
  const body = response.body;
  if (!body) throw new Error('the server sent an event stream with no body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let boundary = buffered.indexOf('\n\n');
      while (boundary !== -1) {
        const block = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('');
        if (data) {
          let frame: Record<string, unknown> = {};
          try {
            frame = JSON.parse(data) as Record<string, unknown>;
          } catch {
            // a keep-alive or a comment frame is not an answer; keep reading
          }
          if (frame.id === id) return frame;
        }
        boundary = buffered.indexOf('\n\n');
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  throw new Error('the event stream ended before the server answered');
}

// ---------- one server ---------------------------------------------------------

export class McpClient {
  private transport: Transport | null = null;
  private discovered: readonly McpToolDescriptor[] = [];

  constructor(private readonly spec: McpServerSpec) {}

  /** Handshake and tool list. Throws with a reason a person can act on. */
  async connect(): Promise<void> {
    const transport =
      this.spec.transport.kind === 'stdio'
        ? new StdioTransport(this.spec.transport)
        : new HttpTransport(this.spec.transport);
    this.transport = transport;
    const result = await transport.request(
      'initialize',
      { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
      MCP_CONNECT_TIMEOUT_MS,
    );
    if (transport instanceof HttpTransport && typeof result.protocolVersion === 'string') {
      transport.useProtocol(result.protocolVersion);
    }
    await transport.notify('notifications/initialized', {});
    this.discovered = await this.listTools(transport);
  }

  private async listTools(transport: Transport): Promise<readonly McpToolDescriptor[]> {
    const found: McpToolDescriptor[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const result = await transport.request('tools/list', cursor ? { cursor } : {}, MCP_CONNECT_TIMEOUT_MS);
      for (const entry of Array.isArray(result.tools) ? result.tools : []) {
        const record = asRecord(entry);
        if (typeof record.name !== 'string' || record.name.length === 0) continue;
        found.push({
          name: record.name,
          description: typeof record.description === 'string' ? record.description : '',
          inputSchema: record.inputSchema ?? { type: 'object', properties: {} },
        });
      }
      cursor = typeof result.nextCursor === 'string' && result.nextCursor.length > 0 ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return found;
  }

  /** The tools this server offers, narrowed to the operator's allowlist. */
  offered(): readonly McpToolDescriptor[] {
    const allowed = this.spec.tools;
    if (allowed === null) return this.discovered;
    return this.discovered.filter((entry) => allowed.includes(entry.name));
  }

  async call(name: string, input: unknown): Promise<string> {
    const transport = this.transport;
    if (!transport) throw new Error(`${this.spec.label} is not connected`);
    const result = await transport.request('tools/call', { name, arguments: input ?? {} }, CALL_TIMEOUT_MS);
    const text = renderContent(result.content);
    // A tool the server itself says failed is a tool error, not a transport
    // one: thrown so it reaches the model the way a built-in failure does.
    if (result.isError === true) throw new Error(text || 'the tool reported an error');
    return text;
  }

  close(): void {
    this.transport?.close();
    this.transport = null;
  }
}

/**
 * Connect once and report what the server offers, so an operator learns whether
 * a record works when they save it rather than when a run needs it. The same
 * bet `probeModel` makes: detecting beats asking.
 */
export async function probeMcpServer(
  spec: McpServerSpec,
): Promise<{ ok: boolean; tools: readonly string[]; detail: string | null }> {
  const client = new McpClient(spec);
  try {
    await client.connect();
    return { ok: true, tools: client.offered().map((entry) => entry.name), detail: null };
  } catch (err) {
    return { ok: false, tools: [], detail: err instanceof Error ? err.message : String(err) };
  } finally {
    client.close();
  }
}

/** MCP content blocks → the one string a tool result is. */
function renderContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((entry) => {
      const block = asRecord(entry);
      if (block.type === 'text' && typeof block.text === 'string') return block.text;
      const resource = asRecord(block.resource);
      if (typeof resource.text === 'string') return resource.text;
      // An image or an audio blob is real output the model cannot be handed as
      // text, so it is named rather than dropped silently or base64-inlined.
      return `[${typeof block.type === 'string' ? block.type : 'unknown'} content omitted]`;
    })
    .join('\n');
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
