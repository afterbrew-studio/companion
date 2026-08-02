/**
 * The companion-runner agent wire protocol.
 *
 * A remote runner is another machine running the `companion-runner` agent: a
 * slim daemon that does locally what companiond does on its own box — spawn
 * moxxy gateways, hold git clones/worktrees, serve session history. companiond
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
export interface AgentHealth {
  readonly ok: true;
  readonly moxxyVersion: string | null;
  readonly moxxyCompatible: boolean;
  readonly liveRuns: number;
  readonly maxRuns: number;
  /** Protocol version so companiond can refuse an incompatible agent. */
  readonly protocol: number;
  /**
   * Model provider names configured in this runner's moxxy home. Placement
   * matches a run's model against these so work lands on a machine that can
   * serve it. Absent on older agents — companiond treats that as unknown
   * (assume capable).
   */
  readonly providers?: readonly string[];
}

/**
 * Version 4 carries the execution access profile into the runner. Without the
 * bump, a new daemon could label an analysis read-only while an older runner
 * silently started it with its former unrestricted policy.
 *
 * `POST /agent/update-moxxy` was added WITHOUT a bump: it's additive — an old
 * agent answers 404 and the daemon falls back to "update it manually" guidance.
 */
export const RUNNER_AGENT_PROTOCOL = 4;

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
 * Added WITHOUT a protocol bump, like `/agent/update-moxxy`: it is additive, so
 * an older agent answers 404 and the daemon records the verification as
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

/**
 * POST /agent/update-moxxy — in-place `npm i -g @moxxy/cli@latest` on the
 * runner's machine, then re-detect. 404 on pre-update agents.
 */
export interface AgentUpdateMoxxyResult {
  readonly previous: string | null;
  readonly version: string | null;
  readonly compatible: boolean;
}

/**
 * POST /agent/providers: add a model provider to the runner's moxxy home by
 * running `moxxy provision` there. One shape at every hop: the browser sends it
 * to companiond, companiond forwards it to the agent, and the agent pipes it to
 * the CLI on stdin.
 *
 * `key` is a live credential. Companion never persists it, never puts it in
 * argv (which `ps` shows to every user on the machine), never logs it, and
 * never returns it. Providers that authenticate with a subscription have no
 * headless path at all: those need `moxxy login <provider>` run on the machine.
 *
 * Added WITHOUT a protocol bump, like `/agent/update-moxxy`: it is additive, so
 * an older agent answers 404 and the daemon turns that into guidance.
 */
export interface ProvisionProviderSpec {
  /**
   * moxxy's provider slug (`anthropic`, `openai`, …). moxxy owns the list and
   * refuses an unknown slug with its own message naming the valid ones, so
   * nothing here validates against a copy of it that would rot.
   */
  readonly provider: string;
  readonly key?: string;
  /** Default model for the provider; omitted keeps moxxy's own default. */
  readonly model?: string;
}

/** POST /agent/runs/:runId/spawn — bring up serve+gateway for a run at `cwd`. */
export interface AgentSpawnRequest {
  readonly cwd: string;
  /** Sticky moxxy session id (companiond uses the run id). */
  readonly sessionId: string;
  /** Immutable per-run policy; runners must reject unknown values. */
  readonly access: AgentRunAccess;
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
