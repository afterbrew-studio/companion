export * from './moxxy.js';

import type { AskRequest, MoxxyEvent } from './moxxy.js';

// ---------- Runs -------------------------------------------------------------

export type RunKind = 'interactive' | 'triage' | 'fix' | 'analysis';

export type RunStatus =
  | 'queued'
  | 'provisioning'
  | 'running'
  | 'review'
  | 'completed'
  | 'abandoned'
  | 'interrupted'
  | 'failed'
  | 'stopped';

export interface RunRecord {
  readonly id: string;
  readonly kind: RunKind;
  readonly status: RunStatus;
  readonly title: string;
  readonly cwd: string;
  /** Repo this run belongs to, `owner/name`; null for scratch/interactive runs. */
  readonly repo: string | null;
  /** Issue/PR number this run is linked to, if any. */
  readonly issueNumber: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** True while a gateway process is attached (live transcript available). */
  readonly live: boolean;
  /** Cumulative token usage folded from provider_response events. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Outcome summary (goal_complete/goal_abandon payload or error message). */
  readonly outcome: string | null;
}

// ---------- REST DTOs ---------------------------------------------------------

export interface SessionBootstrap {
  readonly token: string;
  readonly version: string;
}

export interface MoxxyStatus {
  readonly cliPath: string | null;
  readonly cliVersion: string | null;
  readonly compatible: boolean;
  readonly homeDir: string;
  readonly homeReady: boolean;
  readonly providersImported: boolean;
}

export interface CreateRunRequest {
  readonly kind?: RunKind;
  readonly title?: string;
  readonly prompt?: string;
}

export interface PromptRequest {
  readonly prompt: string;
  readonly model?: string;
}

export interface AskRespondRequest {
  readonly requestId: string;
  readonly response: {
    readonly mode?: 'allow' | 'allow_session' | 'allow_always' | 'deny';
    readonly optionId?: string;
    readonly text?: string;
  };
}

// ---------- SPA WebSocket messages (companiond -> browser) --------------------

export type SpaServerMessage =
  | { readonly t: 'event'; readonly runId: string; readonly event: MoxxyEvent }
  | {
      readonly t: 'turn';
      readonly runId: string;
      readonly phase: 'started' | 'complete';
      readonly turnId?: string;
    }
  | { readonly t: 'ask'; readonly runId: string; readonly ask: AskRequest }
  | { readonly t: 'askResolved'; readonly runId: string; readonly requestId: string }
  | { readonly t: 'run.changed'; readonly run: RunRecord }
  | { readonly t: 'runs.changed' }
  | { readonly t: 'hello'; readonly version: string };
