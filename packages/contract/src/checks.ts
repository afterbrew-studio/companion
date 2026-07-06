/**
 * PR CI pipeline status (GitHub check runs + legacy commit statuses folded
 * into one summary). The snapshot travels on PrRecord for list views; the
 * full per-run breakdown is fetched fresh for detail views and for agents
 * reviewing a PR.
 */

export type CheckState = 'passing' | 'failing' | 'pending' | 'none';

export type CheckConclusion =
  | 'success'
  | 'failure'
  | 'neutral'
  | 'cancelled'
  | 'skipped'
  | 'timed_out'
  | 'action_required'
  | 'stale'
  | null;

export interface CheckRunInfo {
  readonly name: string;
  readonly status: 'queued' | 'in_progress' | 'completed';
  readonly conclusion: CheckConclusion;
  readonly detailsUrl: string | null;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
}

/** Compact form stored on the PR row and pushed to list views. */
export interface ChecksSnapshot {
  readonly state: CheckState;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly pending: number;
  readonly fetchedAt: number;
}

/** Full form for PR detail + agent context. */
export interface ChecksSummary extends ChecksSnapshot {
  readonly repo: string;
  readonly prNumber: number;
  readonly headSha: string | null;
  readonly runs: ReadonlyArray<CheckRunInfo>;
}
