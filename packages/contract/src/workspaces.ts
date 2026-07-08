/**
 * Workspaces group repositories; the three main areas (Proposals, Issues,
 * Pull Requests) are scoped to the active workspace. A repo belongs to exactly
 * one workspace; a fresh install has a "Default" workspace that adopts any
 * repo connected before workspaces existed.
 *
 * Visibility: `public` workspaces are shared with every user; `private` ones
 * are visible only to their members (the creator is the owner). Everything
 * scoped to a workspace — repos, issues, PRs, proposals, notifications —
 * inherits that access. Admins see and manage every workspace.
 */

export type WorkspaceVisibility = 'public' | 'private';

export type WorkspaceMemberRole = 'owner' | 'member';

export interface WorkspaceRecord {
  readonly id: string;
  readonly name: string;
  /** URL-safe handle, unique. */
  readonly slug: string;
  readonly description: string;
  readonly visibility: WorkspaceVisibility;
  /**
   * Username of the owner — the creator of a private workspace, retained even
   * if it's later flipped to public. null for a workspace that never had an
   * owner (an admin-created public one).
   */
  readonly ownerId: string | null;
  readonly createdAt: number;
  /** Computed: number of repos attached. */
  readonly repoCount: number;
  /** Computed for private workspaces: number of members (incl. owner). */
  readonly memberCount: number;
}

/** A member of a private workspace. */
export interface WorkspaceMember {
  readonly username: string;
  readonly displayName: string;
  readonly role: WorkspaceMemberRole;
}

/** A user who could be invited to a private workspace (member-picker search result). */
export interface WorkspaceMemberCandidate {
  readonly username: string;
  readonly displayName: string;
}

export interface CreateWorkspaceRequest {
  readonly name: string;
  readonly description?: string;
  /** Defaults to `private` for non-admins; `public` requires workspaces:manage. */
  readonly visibility?: WorkspaceVisibility;
}

export interface AddWorkspaceMemberRequest {
  readonly username: string;
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
  /** Owner or admin can flip a workspace between public and private. */
  readonly visibility?: WorkspaceVisibility;
}
