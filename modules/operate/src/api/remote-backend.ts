import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type {
  AgentRunAccess,
  AgentDiffResponse,
  AgentVerifyResponse,
  AgentEventMessage,
  AgentHealth,
  AgentHistoryResponse,
  AgentScratchResponse,
  AgentSessionInfoResponse,
  AgentStorageCleanupRequest,
  AgentStorageCleanupResponse,
  AgentWorktreeResponse,
  AgentCloneStatusResponse,
  AskResponse,
  HistorySegment,
  RunTurnArgs,
  RunTurnResult,
} from '@moxxy/companion-types';
import { RUNNER_AGENT_PROTOCOL } from '@moxxy/companion-types';
import { log } from '@moxxy/companion-services';
import type { GitAccess, GitCredentialResolver, RunnerHealth } from '../contract/index.js';
import { DEFAULT_VERIFY_TIMEOUT_MS, type ExecOptions } from '../exec/verify.js';
import type { RunnerBackend, RunnerEventSink } from './backend.js';

const HTTP_TIMEOUT_MS = 30_000;

/**
 * What the daemon tells a remote agent about a run beyond where to put it.
 * Everything is optional: a machine that reported protocol 6 gets none of it
 * and runs what it always ran.
 */
export interface RemoteSpawnPlan {
  readonly harness?: string;
  readonly model?: string | null;
  /** Resolved model spec; only ever sent over https (see `spawn`). */
  readonly spec?: unknown;
  readonly limits?: unknown;
  readonly verifyCommand?: string;
  readonly resultSchema?: unknown;
}

/**
 * A runner on another machine, reached through its companion-runner agent.
 * Every backend method is one authenticated HTTP call to `/agent/*`; a single
 * long-lived WebSocket receives the run event stream and fans it into the
 * shared sink (the same one a local gateway feeds). Working directories are
 * the agent's local paths — opaque here, round-tripped verbatim.
 *
 * Git operations that touch the network carry the hub's GitHub credential
 * (`githubTokenFor`, per repo and owning profile), so the agent machine
 * needs no GitHub configuration of its own.
 */
export class RemoteRunnerBackend implements RunnerBackend {
  private ws: WebSocket | null = null;
  private wsRetry: NodeJS.Timeout | null = null;
  private closed = false;
  /** Runs believed live on the agent (from spawn/gone stream + local tracking). */
  private readonly liveRuns = new Set<string>();

  constructor(
    readonly id: string,
    private readonly endpoint: string,
    private readonly token: string,
    private readonly sink: RunnerEventSink,
    private readonly githubTokenFor: GitCredentialResolver,
    /** Event-stream up/down transitions — the registry probes on both edges. */
    private readonly onStreamState?: (up: boolean) => void,
    /** Instance policy gate; the daemon decides, the runner only executes. */
    private readonly assertPushTarget: (repo: string, branch: string) => void = () => {},
    /**
     * What a run executes as on this machine. Injected because it is a row plus
     * a provider record, neither of which an HTTP client should know how to
     * read; the default keeps the pre-protocol-7 behaviour of saying nothing.
     */
    private readonly spawnPlan: (runId: string) => RemoteSpawnPlan = () => ({}),
  ) {
    this.connectEvents();
  }

  private base(): string {
    return this.endpoint.replace(/\/+$/, '');
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = HTTP_TIMEOUT_MS): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.base()}/agent${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(detail.error ?? `agent ${res.status} on ${path}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async probe(): Promise<RunnerHealth> {
    try {
      // /health is trivial; a machine that can't answer it in 5s is not a
      // machine to place work on — and a hanging probe must not stall the poll.
      const h = await this.call<AgentHealth>('GET', '/health', undefined, 5_000);
      const protocolOk = h.protocol === RUNNER_AGENT_PROTOCOL;
      // A protocol-5 agent has no `runtimes` field. Read the old wire shape
      // defensively so it is diagnosed as outdated instead of falling into the
      // generic offline catch before the protocol mismatch can be reported.
      const runtimes = Array.isArray(h.runtimes) ? h.runtimes : [];
      // Work uses the machine's first runtime unless a lane explicitly says
      // otherwise, so health must judge that same primary rather than a ready
      // fallback no automatic run would reach.
      const primary = runtimes[0] ?? null;
      const runtimeReady = primary?.state === 'ready';
      return {
        status: protocolOk && runtimeReady ? 'online' : 'degraded',
        runtimes: protocolOk ? runtimes : [],
        liveRuns: h.liveRuns,
        maxRuns: h.maxRuns,
        lastSeenAt: Date.now(),
        detail: !protocolOk
          ? `agent protocol ${h.protocol} != ${RUNNER_AGENT_PROTOCOL} (version mismatch)`
          : runtimeReady
            ? null
            : (primary?.detail ?? 'No primary runtime on this machine is ready'),
        agentOutdated: !protocolOk,
      };
    } catch (err) {
      return {
        status: 'offline',
        runtimes: [],
        liveRuns: 0,
        maxRuns: 0,
        lastSeenAt: null,
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async probeRuntime(_harnessId: string): Promise<unknown> {
    const runId = `runtime-probe-${randomUUID().slice(0, 8)}`;
    const cwd = await this.scratchDir(runId);
    try {
      await this.spawn(runId, cwd, 'workspace-write');
      return await this.sessionInfo(runId);
    } finally {
      await this.stop(runId).catch(() => undefined);
    }
  }

  // ---------- gateway lifecycle ----------

  /**
   * Start a run on the agent, telling it which runtime and, where the control
   * plane holds the credentials, which model.
   *
   * The spec carries an API key, so it crosses only over https. A runner on
   * plain http is told the harness and the model reference and resolves the
   * credential from its own configuration; if it has none the spawn fails
   * there, visibly, rather than here with a key already on the wire.
   */
  async spawn(runId: string, cwd: string, access: AgentRunAccess): Promise<void> {
    const plan = this.spawnPlan(runId);
    const secure = this.base().toLowerCase().startsWith('https://');
    await this.call('POST', `/runs/${runId}/spawn`, {
      cwd,
      sessionId: runId,
      access,
      ...(plan.harness ? { harness: plan.harness, model: plan.model } : {}),
      ...(plan.spec !== undefined && secure ? { spec: plan.spec, limits: plan.limits } : {}),
      ...(plan.verifyCommand ? { verifyCommand: plan.verifyCommand } : {}),
      ...(plan.resultSchema !== undefined ? { resultSchema: plan.resultSchema } : {}),
    });
    this.liveRuns.add(runId);
  }
  async stop(runId: string): Promise<void> {
    await this.call('POST', `/runs/${runId}/stop`).catch(() => undefined);
    this.liveRuns.delete(runId);
  }
  isLive(runId: string): boolean {
    return this.liveRuns.has(runId);
  }
  liveIds(): string[] {
    return [...this.liveRuns];
  }

  // ---------- interaction ----------

  async runTurn(runId: string, args: RunTurnArgs): Promise<RunTurnResult> {
    return this.call<RunTurnResult>('POST', `/runs/${runId}/prompt`, args);
  }
  async abortTurn(runId: string, turnId?: string): Promise<void> {
    await this.command(runId, { kind: 'abortTurn', turnId });
  }
  async sessionInfo(runId: string): Promise<unknown> {
    const r = await this.call<AgentSessionInfoResponse>('GET', `/runs/${runId}/session-info`);
    return r.info;
  }
  async setMode(runId: string, mode: string): Promise<void> {
    await this.command(runId, { kind: 'setMode', mode });
  }
  async setModel(runId: string, model: string | null): Promise<void> {
    await this.command(runId, { kind: 'setModel', model });
  }
  async setProvider(runId: string, provider: string): Promise<void> {
    await this.command(runId, { kind: 'setProvider', provider });
  }
  async runCommand(runId: string, name: string, args?: string): Promise<unknown> {
    return this.command(runId, { kind: 'runCommand', name, args });
  }
  async respondAsk(runId: string, requestId: string, response: AskResponse): Promise<void> {
    await this.command(runId, { kind: 'respondAsk', requestId, response });
  }
  private command(runId: string, command: unknown): Promise<unknown> {
    return this.call('POST', `/runs/${runId}/command`, { command });
  }

  async loadHistory(runId: string, before: number | null, limit: number): Promise<HistorySegment> {
    const q = `?limit=${limit}${before === null ? '' : `&before=${before}`}`;
    // Shorter than the default: this call blocks the transcript view, and an
    // updated agent answers within its own ~4s gateway-RPC fallback anyway.
    // Only a pre-fallback agent with a busy gateway ever reaches this deadline.
    return this.call<AgentHistoryResponse>('GET', `/runs/${runId}/history${q}`, undefined, 12_000);
  }

  async writeFile(cwd: string, relPath: string, content: string): Promise<void> {
    await this.call('POST', '/files/write', { cwd, path: relPath, content });
  }

  // ---------- git working area ----------

  async scratchDir(runId: string): Promise<string> {
    return (await this.call<AgentScratchResponse>('POST', '/scratch', { runId })).cwd;
  }
  async hasClone(repo: string): Promise<boolean> {
    return (await this.call<AgentCloneStatusResponse>('POST', '/git/clone-status', { repo })).hasClone;
  }
  async cloneDir(repo: string): Promise<string> {
    return (await this.call<AgentCloneStatusResponse>('POST', '/git/clone-status', { repo })).cloneDir;
  }
  async ensureClone(repo: string, username?: string | null): Promise<void> {
    await this.call('POST', '/git/ensure-clone', { repo, ...(await this.ghToken(repo, username)) });
  }
  async fetchOrigin(repo: string, username?: string | null): Promise<void> {
    await this.call('POST', '/git/fetch', { repo, ...(await this.ghToken(repo, username)) });
  }
  async addWorktree(
    repo: string,
    key: string,
    branch: string,
    baseBranch: string,
    username?: string | null,
  ): Promise<string> {
    return (
      await this.call<AgentWorktreeResponse>('POST', '/git/worktree', {
        repo,
        key,
        branch,
        baseBranch,
        ...(await this.ghToken(repo, username)),
      })
    ).cwd;
  }
  async addWorktreeAtBranch(repo: string, key: string, branch: string, username?: string | null): Promise<string> {
    return (
      await this.call<AgentWorktreeResponse>('POST', '/git/worktree-at', {
        repo,
        key,
        branch,
        ...(await this.ghToken(repo, username)),
      })
    ).cwd;
  }
  async removeWorktree(repo: string, cwd: string): Promise<void> {
    await this.call('POST', '/git/remove-worktree', { repo, cwd });
  }
  async diffVsBase(cwd: string, baseBranch: string): Promise<string> {
    return (await this.call<AgentDiffResponse>('POST', '/git/diff', { cwd, baseBranch })).diff;
  }
  async commitAll(
    cwd: string,
    message: string,
    author?: { name: string; email: string },
    baseBranch?: string,
  ): Promise<void> {
    await this.call('POST', '/git/commit-all', {
      cwd,
      message,
      ...(author ? { author } : {}),
      ...(baseBranch ? { baseBranch } : {}),
    });
  }
  async push(repo: string, cwd: string, branch: string, username?: string | null): Promise<void> {
    // Refuse here, on the daemon, rather than trusting a runner to re-derive the
    // policy: the credential the runner would push with is minted below.
    this.assertPushTarget(repo, branch);
    await this.call('POST', '/git/push', { repo, cwd, branch, ...(await this.ghToken(repo, username, 'write')) });
  }

  /**
   * 404 means this agent predates the endpoint. That degrades to null, not to a
   * failure and not to marking the machine outdated: refusing to place work on an
   * otherwise healthy runner because it cannot run an optional check would be a
   * worse trade than simply not checking.
   */
  async verify(cwd: string, command: string, timeoutMs?: number): Promise<AgentVerifyResponse | null> {
    return this.exec(cwd, command, { timeoutMs });
  }

  async exec(cwd: string, command: string, opts: ExecOptions = {}): Promise<AgentVerifyResponse | null> {
    if (opts.signal) {
      throw new Error(`runner ${this.id} is remote; cancellable commands run on the local runner only`);
    }
    // The agent protocol carries no env field, on purpose (see AgentVerifyRequest).
    // Refusing is the whole point: running the command anyway would execute it
    // unauthenticated and report npm's confusing complaint instead of ours.
    if (opts.env && Object.keys(opts.env).length > 0) {
      throw new Error(
        `runner ${this.id} is remote; commands needing injected credentials run on the local runner only`,
      );
    }
    // No streaming over a single request/response. Dropping the callback
    // silently would show an empty live panel that never fills, which reads as
    // a hung command rather than as an unsupported one.
    if (opts.onChunk) {
      throw new Error(`runner ${this.id} is remote; live command output is available on the local runner only`);
    }
    const timeoutMs = opts.timeoutMs;
    try {
      return await this.call<AgentVerifyResponse>(
        'POST',
        '/verify',
        { cwd, command, timeoutMs, maxOutput: opts.maxOutput },
        (timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS) + 30_000,
      );
    } catch (err) {
      if (/\b404\b/.test(String(err))) return null;
      throw err;
    }
  }

  cleanupStorage(request: AgentStorageCleanupRequest): Promise<AgentStorageCleanupResponse> {
    // Removing dependency-heavy worktrees can take minutes on slower disks.
    return this.call<AgentStorageCleanupResponse>('POST', '/storage/cleanup', request, 10 * 60_000);
  }

  /** Every remote network operation carries the run owner's verified token;
   * never let the runner fall back to a machine-wide credential. */
  private async ghToken(
    repo: string,
    username?: string | null,
    access: GitAccess = 'read',
  ): Promise<{ githubToken: string }> {
    const token = await this.githubTokenFor(repo, username, access);
    if (!token) {
      throw new Error(
        access === 'write'
          ? `no personal GitHub credential with push access to ${repo} — connect an account with write access, or ask the repository owner to grant it`
          : `no personal GitHub credential with access to ${repo}`,
      );
    }
    return { githubToken: token };
  }

  // ---------- event stream ----------

  private connectEvents(): void {
    if (this.closed) return;
    const url = `${this.base().replace(/^http/, 'ws')}/agent/events?token=${encodeURIComponent(this.token)}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on('open', () => this.onStreamState?.(true));
    ws.on('message', (data) => {
      let msg: AgentEventMessage;
      try {
        msg = JSON.parse(String(data)) as AgentEventMessage;
      } catch {
        return;
      }
      switch (msg.t) {
        case 'event':
          this.sink.onEvent(msg.runId, msg.event);
          break;
        case 'turn.complete':
          this.sink.onTurnComplete(msg.runId, msg.turnId);
          break;
        case 'ask':
          this.sink.onAsk(msg.runId, msg.ask);
          break;
        case 'ask.resolved':
          this.sink.onAskResolved(msg.runId, msg.requestId);
          break;
        case 'gone':
          this.liveRuns.delete(msg.runId);
          this.sink.onGone(msg.runId);
          break;
        default:
          break;
      }
    });
    ws.on('close', () => this.scheduleReconnect());
    ws.on('error', (err) => {
      log.warn('runner agent event stream error', { runner: this.id, err: String(err) });
      ws.close();
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.wsRetry) return;
    this.onStreamState?.(false);
    // Agent restarts reap its gateways; mark our runs gone so the UI reflects it.
    for (const runId of [...this.liveRuns]) {
      this.liveRuns.delete(runId);
      this.sink.onGone(runId);
    }
    this.wsRetry = setTimeout(() => {
      this.wsRetry = null;
      this.connectEvents();
    }, 5_000);
  }

  dispose(): void {
    this.closed = true;
    if (this.wsRetry) clearTimeout(this.wsRetry);
    this.ws?.close();
    this.ws = null;
  }
}
