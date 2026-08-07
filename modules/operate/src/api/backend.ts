import type {
  AgentRunAccess,
  AgentStorageCleanupRequest,
  AgentStorageCleanupResponse,
  AgentToolHealth,
  AgentToolProbe,
  AgentVerifyResponse,
  AskRequest,
  AskResponse,
  HistorySegment,
  MoxxyEvent,
  RunTurnArgs,
  RunTurnResult,
} from '@moxxy/companion-types';
import type { ExecOptions } from '../exec/verify.js';
import type { ToolRunResult } from '../exec/tool-exec.js';
import type { RunnerHealth } from '../contract/index.js';

/** One developer tool invocation, on whichever machine holds the worktree. */
export interface RunnerToolRequest {
  /** A worktree or scratch dir this backend handed out. */
  readonly cwd: string;
  /** Candidate executables in preference order; the first installed one runs. */
  readonly binaries: readonly string[];
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Complete stdout lines as they arrive, so a long tool can report progress. */
  readonly onLine?: (line: string) => void;
  readonly maxStdout?: number;
  readonly maxStderr?: number;
  /**
   * Per-invocation environment. It can carry a credential, so a remote backend
   * sends it only over https and REFUSES otherwise: running the tool
   * unauthenticated instead would report the tool's confusing complaint rather
   * than ours.
   */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * A RunnerBackend is everything the orchestrator needs to run an agent on a
 * particular machine: the gateway lifecycle, the interaction surface, the git
 * working area, and session history. `LocalRunnerBackend` forwards to the
 * in-process GatewayPool + Checkouts (today's behavior, unchanged);
 * `RemoteRunnerBackend` proxies each call to a companion-runner agent.
 *
 * Working directories (cwd, worktree paths) are backend-owned: for remote runs
 * they are paths on the agent's machine, opaque to companiond, which only
 * stores them on the run row and hands them back.
 */
export interface RunnerBackend {
  readonly id: string;

  /** Probe the machine — feeds the health poller and the "Test connection" action. */
  probe(): Promise<RunnerHealth>;

  /** Start one short-lived session through a named runtime and return the
   * capability information it reports. Provider discovery is built on this,
   * independently of any particular runtime's config files. */
  probeRuntime(harnessId: string): Promise<unknown>;

  // ---------- gateway lifecycle ----------
  /** Bring up serve+gateway for a run whose working dir is `cwd`. */
  spawn(runId: string, cwd: string, access: AgentRunAccess): Promise<void>;
  stop(runId: string): Promise<void>;
  isLive(runId: string): boolean;
  liveIds(): string[];

  // ---------- interaction (proxied to the gateway) ----------
  runTurn(runId: string, args: RunTurnArgs): Promise<RunTurnResult>;
  abortTurn(runId: string, turnId?: string): Promise<void>;
  sessionInfo(runId: string): Promise<unknown>;
  setMode(runId: string, mode: string): Promise<void>;
  setModel(runId: string, model: string | null): Promise<void>;
  setProvider(runId: string, provider: string): Promise<void>;
  runCommand(runId: string, name: string, args?: string): Promise<unknown>;
  respondAsk(runId: string, requestId: string, response: AskResponse): Promise<void>;
  /** Gateway when live, else the session JSONL on the runner's disk. */
  loadHistory(runId: string, before: number | null, limit: number): Promise<HistorySegment>;

  /** Drop a small file into a run's working dir (e.g. AI Help's scoped creds). */
  writeFile(cwd: string, relPath: string, content: string): Promise<void>;

  // ---------- git working area (proxied to Checkouts) ----------
  /** Throwaway working dir for scratch/interactive runs (returns the cwd). */
  scratchDir(runId: string): Promise<string>;
  hasClone(repo: string): Promise<boolean>;
  cloneDir(repo: string): Promise<string>;
  ensureClone(repo: string, username?: string | null): Promise<void>;
  /** Refresh all origin refs of the clone (e.g. a fresh base before a merge). */
  fetchOrigin(repo: string, username?: string | null): Promise<void>;
  addWorktree(repo: string, key: string, branch: string, baseBranch: string, username?: string | null): Promise<string>;
  addWorktreeAtBranch(repo: string, key: string, branch: string, username?: string | null): Promise<string>;
  /**
   * Detached worktree at a pull request's head ref: what a code review reads,
   * and the one checkout shape that also works for forks.
   *
   * Resolves to null on a runner agent that predates the endpoint, which the
   * caller treats as "this machine cannot host a review" rather than a failure.
   */
  addPullRequestWorktree(
    repo: string,
    key: string,
    prNumber: number,
    baseBranch: string,
    username?: string | null,
  ): Promise<string | null>;
  removeWorktree(repo: string, cwd: string): Promise<void>;
  diffVsBase(cwd: string, baseBranch: string): Promise<string>;
  commitAll(
    cwd: string,
    message: string,
    author?: { name: string; email: string },
    baseBranch?: string,
  ): Promise<void>;
  push(repo: string, cwd: string, branch: string, username?: string | null): Promise<void>;

  /** Enforce daemon-owned retention inside this runner's managed roots. */
  cleanupStorage(request: AgentStorageCleanupRequest): Promise<AgentStorageCleanupResponse>;
  /**
   * Run a repository's verification command in a worktree on this machine.
   * Resolves to null when the machine cannot do it (an agent predating the
   * endpoint), which the caller records as 'unavailable' rather than a failure:
   * "we could not check" and "it does not build" are different answers.
   */
  verify(cwd: string, command: string, timeoutMs?: number): Promise<AgentVerifyResponse | null>;

  /**
   * Run an arbitrary command in a prepared working directory. The general form
   * of `verify`, used by executable pipeline steps.
   *
   * `opts.env` is a per-invocation overlay and is the only channel a credential
   * may take. A backend that cannot keep that overlay on this machine must
   * REJECT rather than run the command without it: silently dropping a secret
   * turns "this runner cannot do that" into "npm is not authenticated", which is
   * a far worse thing to debug at publish time.
   *
   * Resolves to null on a runner too old to have the endpoint, exactly like
   * `verify`.
   */
  exec(cwd: string, command: string, opts?: ExecOptions): Promise<AgentVerifyResponse | null>;

  // ---------- developer tools installed on the machine ----------

  /**
   * Whether this machine has each named executable.
   *
   * Resolves to null on a runner agent too old to answer. That is "unknown",
   * not "none": treating silence as absence would quietly stop routing reviews
   * to a machine that has the tool, with nothing to show for the change.
   */
  detectTools(probes: readonly AgentToolProbe[]): Promise<readonly AgentToolHealth[] | null>;

  /**
   * Run one developer tool in a worktree on this machine. Null on an agent too
   * old to have the endpoint, for the same reason `verify` degrades that way.
   */
  runTool(request: RunnerToolRequest): Promise<ToolRunResult | null>;
}

/** The event sink a backend feeds — one shared instance drives the orchestrator. */
export interface RunnerEventSink {
  onEvent(runId: string, event: MoxxyEvent): void;
  onTurnComplete(runId: string, turnId?: string): void;
  onAsk(runId: string, ask: AskRequest): void;
  onAskResolved(runId: string, requestId: string): void;
  onGone(runId: string): void;
  /** A runner's health transitioned to offline — its stranded runs must not stay "live". */
  onRunnerUnreachable(runnerId: string, detail: string): void;
  /** The same transition the other way, so an outage that ended can be reported. */
  onRunnerReachable(runnerId: string): void;
}
