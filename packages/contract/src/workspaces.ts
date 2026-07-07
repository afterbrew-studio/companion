/**
 * Workspaces group repositories; the three main areas (Proposals, Issues,
 * Pull Requests) are scoped to the active workspace. A repo belongs to exactly
 * one workspace; a fresh install has a "Default" workspace that adopts any
 * repo connected before workspaces existed.
 */

export interface WorkspaceRecord {
  readonly id: string;
  readonly name: string;
  /** URL-safe handle, unique. */
  readonly slug: string;
  readonly description: string;
  readonly createdAt: number;
  /** Computed: number of repos attached. */
  readonly repoCount: number;
}

export interface CreateWorkspaceRequest {
  readonly name: string;
  readonly description?: string;
}

// ---------- metrics ---------------------------------------------------------------

/** One calendar week (Monday-start, local to the daemon) of activity. */
export interface WeeklyCounts {
  readonly weekStart: number;
  readonly issuesOpened: number;
  readonly issuesClosed: number;
  readonly prsOpened: number;
  readonly prsClosed: number;
}

export interface WorkspaceMetrics {
  readonly openIssues: number;
  readonly closedIssues: number;
  readonly openPrs: number;
  readonly mergedPrs: number;
  readonly issuesOpenedThisWeek: number;
  readonly issuesClosedThisWeek: number;
  readonly prsOpenedThisWeek: number;
  readonly prsClosedThisWeek: number;
  /**
   * Rolling windows (trailing 7 days vs the 7 before) — the honest delta base:
   * calendar "this week" is partial and reads as a fake drop early in the week.
   */
  readonly issuesOpened7d: number;
  readonly issuesOpenedPrev7d: number;
  readonly issuesClosed7d: number;
  readonly issuesClosedPrev7d: number;
  readonly prsOpened7d: number;
  readonly prsOpenedPrev7d: number;
  readonly prsClosed7d: number;
  readonly prsClosedPrev7d: number;
  /** Oldest → newest, includes the current (partial) week. */
  readonly weekly: ReadonlyArray<WeeklyCounts>;
}

export interface UpdateWorkspaceRequest {
  readonly name?: string;
  readonly description?: string;
}
