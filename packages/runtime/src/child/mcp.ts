import { jsonSchema, tool, type ToolSet } from 'ai';
import type { McpServerSpec } from '../mcp.js';
import { McpClient } from '../mcp-client.js';
import type { RuntimeLimits } from '../spec.js';

/**
 * The MCP servers a run was given, as tools the model can call.
 *
 * This is the SDK-facing half; the protocol itself is in `../mcp-client.ts`.
 * A server that will not connect costs its own tools and nothing else: the run
 * continues with what it has and the failure goes on the transcript, because a
 * coding run that dies because an unrelated integration is down is a worse
 * outcome than one that says which tools it did not get.
 */
export class McpHub {
  private readonly clients = new Map<string, McpClient>();
  private connecting: Promise<void> | null = null;

  constructor(
    private readonly servers: readonly McpServerSpec[],
    private readonly limits: RuntimeLimits,
    private readonly onProblem: (server: string, detail: string) => void,
  ) {}

  get empty(): boolean {
    return this.servers.length === 0;
  }

  /** Connect every server once. Safe to await from each turn. */
  async ready(): Promise<void> {
    if (!this.connecting) {
      this.connecting = Promise.all(
        this.servers.map(async (spec) => {
          const client = new McpClient(spec);
          try {
            await client.connect();
            this.clients.set(spec.id, client);
          } catch (err) {
            client.close();
            this.onProblem(spec.label, err instanceof Error ? err.message : String(err));
          }
        }),
      ).then(() => undefined);
    }
    await this.connecting;
  }

  /**
   * The connected tools, namespaced by server.
   *
   * The prefix is not decoration: two servers may offer `search`, and a name
   * that collided would silently shadow one of them. It also keeps an MCP tool
   * from ever being mistaken for a built-in one in a transcript or an approval.
   *
   * Rebuilt on every call, never cached. The approval guard replaces `execute`
   * on the tool object in place, so a shared instance would collect one wrapper
   * per turn and ask a person to approve the same call twice, then three times.
   */
  toolSet(): ToolSet {
    const tools: ToolSet = {};
    for (const [id, client] of this.clients) {
      for (const entry of client.offered()) {
        const name = toolName(id, entry.name);
        if (tools[name]) continue; // two names that sanitise onto one: first wins
        tools[name] = tool({
          description: clip(entry.description || `${entry.name} (provided by ${id})`, 1_000),
          inputSchema: jsonSchema(entry.inputSchema as Parameters<typeof jsonSchema>[0]),
          execute: async (input: unknown) => clip(await client.call(entry.name, input), this.limits.toolOutputChars),
        });
      }
    }
    return tools;
  }

  close(): void {
    for (const [, client] of this.clients) client.close();
    this.clients.clear();
  }
}

/**
 * `mcp__<server>__<tool>`, clipped to what providers accept as a function name.
 * Anything outside `[A-Za-z0-9_-]` becomes an underscore, because a server is
 * free to name a tool in a way an OpenAI-compatible endpoint rejects, and the
 * whole turn would fail on it rather than the one tool.
 */
function toolName(serverId: string, name: string): string {
  return `mcp__${safe(serverId)}__${safe(name)}`.slice(0, 64);
}

function safe(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_');
}

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… ${text.length - limit} more characters were dropped`;
}
