import type { WorkspacesStore } from '../api/workspaces-store.js';

/**
 * module-workspace contract slice — workspaces + membership + access-control
 * (the scoping key every workspace-scoped table filters on) + dashboard metrics.
 */

declare module '@companion/contracts' {
  interface PermissionRegistry {
    'workspaces:read': true;
    'workspaces:create': true;
    'workspaces:manage': true;
  }
  interface ServerMessageRegistry {
    'workspaces.changed': Record<never, never>;
  }
  interface ServiceMap {
    /** The access-control owner; consumers scope through it (never raw SQL against workspaces). */
    workspace: WorkspacesStore;
  }
}

export type WorkspaceVisibility = 'public' | 'private';
export type WorkspaceMemberRole = 'owner' | 'member';

export interface WorkspaceRecord {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly description: string;
  readonly visibility: WorkspaceVisibility;
  readonly ownerId: string | null;
  readonly createdAt: number;
  readonly repoCount: number;
  readonly memberCount: number;
}

export interface WorkspaceMember {
  readonly username: string;
  readonly displayName: string;
  readonly role: WorkspaceMemberRole;
}

export interface WorkspaceMemberCandidate {
  readonly username: string;
  readonly displayName: string;
}

export interface CreateWorkspaceRequest {
  readonly name: string;
  readonly description?: string;
  readonly visibility?: WorkspaceVisibility;
}

export interface AddWorkspaceMemberRequest {
  readonly username: string;
}

export interface UpdateWorkspaceRequest {
  readonly name?: string;
  readonly description?: string;
  readonly visibility?: WorkspaceVisibility;
}

// ---------- metrics ----------

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
  readonly issuesOpened7d: number;
  readonly issuesOpenedPrev7d: number;
  readonly issuesClosed7d: number;
  readonly issuesClosedPrev7d: number;
  readonly prsOpened7d: number;
  readonly prsOpenedPrev7d: number;
  readonly prsClosed7d: number;
  readonly prsClosedPrev7d: number;
  readonly weekly: ReadonlyArray<WeeklyCounts>;
}
