export * from './moxxy.js';

import type { AskRequest, MoxxyEvent } from './moxxy.js';

// ---------- Runs -------------------------------------------------------------

export type RunKind = 'interactive' | 'triage' | 'fix' | 'analysis' | 'implement' | 'report';

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
  /** Proposal this run implements, if any. */
  readonly proposalId: string | null;
  /** Branch a fix/implement run works on (in its worktree). */
  readonly branch: string | null;
  /** PR opened from this run's branch, if any. */
  readonly prUrl: string | null;
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

// ---------- GitHub domain -----------------------------------------------------

export interface RepoRecord {
  /** `owner/name` — the primary key everywhere. */
  readonly fullName: string;
  readonly owner: string;
  readonly name: string;
  readonly defaultBranch: string;
  readonly private: boolean;
  readonly cloneReady: boolean;
  readonly lastSyncAt: number | null;
  readonly openIssues: number;
  /** Automation switches. */
  readonly autoTriage: boolean;
  readonly digestEnabled: boolean;
  readonly staleSweepEnabled: boolean;
  /** Auto-analyze newly opened PRs (webhook) and post the review when confident. */
  readonly prGateEnabled: boolean;
  /** Set once a webhook secret was generated (receiver active). */
  readonly webhookConfigured: boolean;
}

export interface IssueRecord {
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: 'open' | 'closed';
  readonly labels: ReadonlyArray<string>;
  readonly author: string;
  readonly assignees: ReadonlyArray<string>;
  readonly comments: number;
  readonly url: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Latest triage result status for this issue, if any. */
  readonly triage: 'pending' | 'applied' | 'dismissed' | null;
}

export interface PrRecord {
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: 'open' | 'closed' | 'merged';
  readonly headRef: string;
  readonly baseRef: string;
  readonly draft: boolean;
  readonly author: string;
  readonly url: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** Latest AI review status for this PR, if any. */
  readonly review: 'pending' | 'applied' | 'dismissed' | null;
}

// ---------- PR reviews -----------------------------------------------------------

export interface PrReviewVerdict {
  readonly summary: string;
  readonly risk: 'low' | 'medium' | 'high';
  readonly recommendation: 'approve' | 'request_changes' | 'comment';
  readonly findings: ReadonlyArray<string>;
  readonly reviewBody: string;
}

export interface PrReviewResult {
  readonly id: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly runId: string;
  readonly status: 'pending' | 'applied' | 'dismissed' | 'failed';
  readonly verdict: PrReviewVerdict | null;
  readonly error: string | null;
  readonly createdAt: number;
}

// ---------- Triage -------------------------------------------------------------

export interface TriageVerdict {
  readonly summary: string;
  readonly severity: 'critical' | 'high' | 'medium' | 'low' | 'trivial';
  readonly kind: 'bug' | 'feature' | 'question' | 'docs' | 'chore' | 'invalid';
  readonly labels: ReadonlyArray<string>;
  readonly duplicateOf: number | null;
  readonly needsInfo: boolean;
  readonly draftReply: string;
}

export interface TriageResult {
  readonly id: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly runId: string;
  readonly status: 'pending' | 'applied' | 'dismissed' | 'failed';
  readonly verdict: TriageVerdict | null;
  readonly error: string | null;
  readonly createdAt: number;
}

// ---------- Proposals -----------------------------------------------------------

export interface ProposalAnalysis {
  readonly summary: string;
  readonly feasibility: 'low' | 'medium' | 'high';
  readonly steps: ReadonlyArray<string>;
  readonly touchedAreas: ReadonlyArray<string>;
  readonly risks: ReadonlyArray<string>;
}

export interface ProposalRecord {
  readonly id: string;
  readonly repo: string;
  readonly title: string;
  readonly body: string;
  readonly status:
    | 'draft'
    | 'analyzing'
    | 'analyzed'
    | 'approved'
    | 'implementing'
    | 'review'
    | 'implemented'
    | 'rejected'
    | 'failed';
  readonly analysis: ProposalAnalysis | null;
  readonly analysisRunId: string | null;
  readonly implementRunId: string | null;
  readonly branch: string | null;
  readonly prUrl: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ---------- Automations ----------------------------------------------------------

export interface ReportRecord {
  readonly id: string;
  readonly repo: string | null;
  readonly kind: 'digest' | 'stale-sweep' | 'webhook';
  readonly title: string;
  readonly body: string;
  readonly createdAt: number;
}

export interface WebhookInfo {
  /** Deliveries POST here (behind the user's tunnel / port-forward). */
  readonly path: string;
  readonly secret: string;
}

// ---------- Skills -----------------------------------------------------------------

export interface SkillFile {
  readonly name: string;
  readonly content: string;
  readonly updatedAt: number;
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
  readonly githubConfigured: boolean;
  readonly githubUser: string | null;
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
  | { readonly t: 'repos.changed' }
  | { readonly t: 'issues.changed'; readonly repo: string }
  | { readonly t: 'triage.changed'; readonly repo: string }
  | { readonly t: 'prs.changed'; readonly repo: string }
  | { readonly t: 'proposals.changed' }
  | { readonly t: 'reports.changed' }
  | { readonly t: 'hello'; readonly version: string };
