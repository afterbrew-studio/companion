/**
 * The companion-runner agent wire protocol.
 *
 * A remote runner is another machine running the `companion-runner` agent: a
 * slim daemon that does locally what companiond does on its own box — spawn
 * agent runtimes, hold git clones/worktrees, serve session history. companiond
 * drives it over this HTTP + WebSocket API. Both sides import these types so
 * the contract can't drift.
 *
 * Transport:
 *   - HTTP  POST/GET under `/agent/*`, bearer-token auth (the runner's token).
 *   - WS    `/agent/events?token=…` — the agent pushes run events, ask
 *           requests/resolutions, turn completions, and gone notices; the
 *           daemon fans them into the same sinks a local gateway feeds.
 *
 * Working directories (cwd, worktree paths) are OPAQUE to companiond for
 * remote runs — they are paths on the agent's machine. companiond only stores
 * them on the run row and hands them back to the agent verbatim.
 */

import type { AskRequest, AskResponse, HarnessEvent, HistorySegment, PromptAttachment } from './harness.js';

/** GET /agent/health */
export interface AgentRuntimeHealth {
  readonly id: string;
  readonly label: string;
  readonly version: string | null;
  readonly state: 'ready' | 'unavailable';
  readonly detail: string | null;
  /**
   * The runtime is installed and has no model of its own (protocol 7).
   *
   * The machine cannot answer whether that matters, because only the daemon
   * knows whether it reaches this runner over https and therefore whether it
   * may send one. So the agent reports `unavailable` and states the fact; the
   * daemon upgrades it to ready when it can supply the model itself. Both sides
   * stay honest, and neither has to guess the other's configuration.
   */
  readonly needsModel?: boolean;
}

export interface AgentHealth {
  readonly ok: true;
  readonly runtimes: readonly AgentRuntimeHealth[];
  readonly liveRuns: number;
  readonly maxRuns: number;
  /** Protocol version so companiond can refuse an incompatible agent. */
  readonly protocol: number;
}

/**
 * Version 6 replaces implementation-specific health fields with the runtime
 * list the machine actually exposes. A previous agent is rejected rather than
 * having one runtime silently treated as the machine itself.
 *
 * Version 7 lets a spawn say WHICH runtime to start, and hand it a resolved
 * model. Before it, every remote machine ran moxxy whatever its row said, so a
 * run recorded under another harness could only be kept off remote machines
 * entirely. A version 6 agent still works: it ignores the new fields and runs
 * what it always ran, which is why the daemon only places a non-moxxy run on a
 * machine that reported 7.
 */
export const RUNNER_AGENT_PROTOCOL = 7;

/**
 * The hard execution boundary selected by Companion for a run. It is separate
 * from RunKind: kind describes the product job, while access is the least
 * privilege the selected harness is allowed to exercise.
 */
export type AgentRunAccess = 'read-only' | 'workspace-write' | 'trusted-assistant';

/**
 * POST /agent/verify — run a repository's own verification command inside a
 * prepared worktree on this machine, so a diff that does not build is known
 * before a human or a CI run is spent on it.
 *
 * Added without its own protocol bump: an older agent answers 404 and the daemon records the verification as
 * unavailable instead of marking a working machine outdated and refusing to
 * place work on it.
 */
export interface AgentVerifyRequest {
  readonly cwd: string;
  readonly command: string;
  readonly timeoutMs?: number;
  /**
   * How much output to keep. Safe to add without a protocol bump because an
   * older agent ignoring it simply clips at its own default.
   *
   * There is deliberately NO `env` field. A secret sent to an agent too old to
   * read it would produce an unauthenticated command rather than a refusal, and
   * "npm is not logged in" is a much worse diagnosis than "this runner is too
   * old". Env overlays are a local-backend capability; the remote backend
   * refuses them outright.
   */
  readonly maxOutput?: number;
}

export interface AgentVerifyResponse {
  /** null when the process died on a signal or never started. */
  readonly exitCode: number | null;
  /** Combined output, tail-clipped by the runner. */
  readonly output: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

/** POST /agent/runs/:runId/spawn — bring up serve+gateway for a run at `cwd`. */
export interface AgentSpawnRequest {
  readonly cwd: string;
  /** Sticky moxxy session id (companiond uses the run id). */
  readonly sessionId: string;
  /** Immutable per-run policy; runners must reject unknown values. */
  readonly access: AgentRunAccess;
  /**
   * Which runtime to start (protocol 7). Absent means the machine's own
   * default, which is what every agent before 7 did unconditionally.
   */
  readonly harness?: string;
  /** Model reference for that runtime, as recorded on the run. */
  readonly model?: string | null;
  /**
   * A resolved model spec for a runtime whose credentials the CONTROL PLANE
   * holds. Opaque here: its shape belongs to the runtime that reads it.
   *
   * It carries an API key, so the daemon sends it only over https. A runner
   * reached over plain http resolves its own model from its own configuration
   * instead, exactly as `COMPANION_RUNNER_GITHUB_TOKEN` overrides the hub's git
   * credential. Refusing loudly beats shipping a credential in the clear.
   */
  readonly spec?: unknown;
  /** Resource ceilings the runtime enforces on itself. */
  readonly limits?: unknown;
  /**
   * MCP servers this run may reach, already filtered by the daemon's policy and
   * opaque here for the same reason `spec` is.
   *
   * They can carry credentials, so they travel under the https rule `spec`
   * does. Added without a protocol bump: an agent too old to read the field
   * runs the same work with its built-in tools alone, which is a smaller loss
   * than refusing to place the run at all.
   */
  readonly mcpServers?: unknown;
  /** The repository's own verification command, when one is configured. */
  readonly verifyCommand?: string;
  /** JSON Schema the caller wants the answer in (structured one-shots). */
  readonly resultSchema?: unknown;
  /**
   * Somebody is watching this run, so a runtime that can ask before a tool call
   * will actually be answered. Absent means unattended, which is what every
   * agent before protocol 7 assumed.
   */
  readonly attended?: boolean;
}

/** POST /agent/runs/:runId/prompt */
export interface AgentPromptRequest {
  readonly prompt: string;
  readonly model?: string;
  readonly attachments?: readonly PromptAttachment[];
}

/**
 * POST /agent/files/write — drop a small file into a run's working dir (used to
 * hand AI Help its scoped credentials). `cwd` must be one the agent handed out
 * (under its scratch/worktrees root); `path` is relative and may not escape it.
 */
export interface AgentWriteFileRequest {
  readonly cwd: string;
  readonly path: string;
  readonly content: string;
  /** Octal file mode (e.g. 0o600); defaults to 0o600 for credential hygiene. */
  readonly mode?: number;
}

/** POST /agent/runs/:runId/command — the misc typed gateway commands. */
export interface AgentCommandRequest {
  readonly command:
    | { readonly kind: 'abortTurn'; readonly turnId?: string }
    | { readonly kind: 'setMode'; readonly mode: string }
    | { readonly kind: 'setModel'; readonly model: string | null }
    | { readonly kind: 'setProvider'; readonly provider: string }
    | { readonly kind: 'setAutoApprove'; readonly enabled: boolean }
    | { readonly kind: 'runCommand'; readonly name: string; readonly args?: string }
    | { readonly kind: 'respondAsk'; readonly requestId: string; readonly response: AskResponse };
}

/** GET /agent/runs/:runId/history?before=&limit= */
export type AgentHistoryResponse = HistorySegment;

/** GET /agent/runs/:runId/session-info */
export interface AgentSessionInfoResponse {
  readonly info: unknown;
}

// ---------- git working area (proxied Checkouts) -------------------------------

/** POST /agent/git/clone-status */
export interface AgentCloneStatusRequest {
  readonly repo: string;
}
export interface AgentCloneStatusResponse {
  readonly hasClone: boolean;
  /** Agent-local clone path (opaque to companiond). */
  readonly cloneDir: string;
}

/**
 * POST /agent/git/ensure-clone — clone if missing.
 *
 * `githubToken` on this and the other network-touching git requests is the
 * hub's configured GitHub credential, sent per call so the agent needs no
 * GitHub setup of its own. The agent holds it in memory only for that one git
 * invocation (same ephemeral-credential-helper hygiene as Checkouts). A
 * COMPANION_RUNNER_GITHUB_TOKEN set on the agent's machine overrides it.
 */
export interface AgentEnsureCloneRequest {
  readonly repo: string;
  readonly githubToken?: string;
}

/** POST /agent/git/fetch — refresh all origin refs of an existing clone. */
export interface AgentFetchRequest {
  readonly repo: string;
  readonly githubToken?: string;
}

/** POST /agent/git/worktree — create a fresh branch off a base (fetches). */
export interface AgentWorktreeRequest {
  readonly repo: string;
  readonly key: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly githubToken?: string;
}
/** POST /agent/git/worktree-at — check out at an existing remote branch (PR head). */
export interface AgentWorktreeAtRequest {
  readonly repo: string;
  readonly key: string;
  readonly branch: string;
  readonly githubToken?: string;
}
export interface AgentWorktreeResponse {
  /** Agent-local worktree path — becomes the run's cwd (opaque to companiond). */
  readonly cwd: string;
}

/** POST /agent/git/diff */
export interface AgentDiffRequest {
  readonly cwd: string;
  readonly baseBranch: string;
}
export interface AgentDiffResponse {
  readonly diff: string;
}

/** POST /agent/git/commit-all */
export interface AgentCommitRequest {
  readonly cwd: string;
  readonly message: string;
  readonly author?: {
    readonly name: string;
    readonly email: string;
  };
  /** Fresh PR only: collapse all branch work onto this trusted origin ref. */
  readonly baseBranch?: string;
}
/** POST /agent/git/push */
export interface AgentPushRequest {
  readonly repo: string;
  readonly cwd: string;
  readonly branch: string;
  readonly githubToken?: string;
}
/** POST /agent/git/remove-worktree */
export interface AgentRemoveWorktreeRequest {
  readonly repo: string;
  readonly cwd: string;
}
/** POST /agent/scratch — allocate a throwaway working dir for a scratch run. */
export interface AgentScratchRequest {
  readonly runId: string;
}
export interface AgentScratchResponse {
  readonly cwd: string;
}

// ---------- platform-enforced storage cleanup ---------------------------------

/** Run state the daemon leases to the runner while enforcing retention. */
export interface AgentStorageRunLease {
  readonly runId: string;
  /** Runner-local cwd previously returned by this runner (opaque to companiond). */
  readonly cwd: string;
  /** Daemon-side lifecycle timestamp, used when it is newer than filesystem mtime. */
  readonly updatedAt: number;
  /** Active/review work must survive regardless of age. */
  readonly protected: boolean;
}

/** POST /agent/storage/cleanup — policy is owned by companiond, execution by the runner. */
export interface AgentStorageCleanupRequest {
  readonly worktreeRetentionMs: number;
  readonly scratchRetentionMs: number;
  readonly sessionRetentionMs: number;
  readonly runs: readonly AgentStorageRunLease[];
}

export interface AgentStorageCleanupResponse {
  readonly removedWorktrees: number;
  readonly removedScratchDirs: number;
  readonly removedSessionFiles: number;
  readonly removedRunConfigs: number;
  /** Basenames only — runner filesystem paths never need to cross the wire. */
  readonly errors: readonly string[];
}

// ---------- WS event envelope (agent → companiond) -----------------------------

export type AgentEventMessage =
  | { readonly t: 'event'; readonly runId: string; readonly event: HarnessEvent }
  | { readonly t: 'turn.complete'; readonly runId: string; readonly turnId?: string }
  | { readonly t: 'ask'; readonly runId: string; readonly ask: AskRequest }
  | { readonly t: 'ask.resolved'; readonly runId: string; readonly requestId: string }
  | { readonly t: 'gone'; readonly runId: string }
  | { readonly t: 'hello'; readonly protocol: number };
