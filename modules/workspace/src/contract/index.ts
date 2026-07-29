// Brings module-core's ServiceMap { core: Auth } + permission augmentations
// (module-workspace dependsOn core, and calls Auth via ctx.services.get('core')).
import '@companion/module-core/contract';
import type { WorkspacesStore } from '../api/workspaces-store.js';
import type { NotificationsService } from '../api/notifications-service.js';
import type { ReportsStore } from '../api/reports-store.js';

/**
 * module-workspace contract slice — workspaces + membership + access-control
 * (the scoping key every workspace-scoped table filters on) + dashboard metrics
 * + the notification inbox (workspace-scoped, so it lives with access control)
 * + the generated-reports store (digests, sweeps, ci-analyses, briefings).
 */

declare module '@moxxy/companion-contracts' {
  interface PermissionRegistry {
    'workspaces:read': true;
    'workspaces:create': true;
    'workspaces:manage': true;
    'reports:read': true;
  }
  interface ServerMessageRegistry {
    'workspaces.changed': Record<never, never>;
    'notifications.changed': Record<never, never>;
    'reports.changed': Record<never, never>;
  }
  interface ServiceMap {
    /** The access-control owner; consumers scope through it (never raw SQL against workspaces). */
    workspace: WorkspacesStore;
    /** The inbox emitter + reader; the kernel's `ctx.notify` proxy resolves here. */
    notifications: NotificationsService;
    /** Generated digests/analyses; producer modules (code, automations) write through this. */
    reports: ReportsStore;
  }
  interface BusEvents {
    /**
     * An inbox entry was raised. Every notification in the product is minted by
     * `ctx.notify.emit`, so this is the one place a module can watch all of
     * them — outbound delivery subscribes here rather than every producer
     * learning about every sink. Soft: no dependsOn edge needed, and nothing
     * downstream may fail the emit.
     */
    'notification.raised': NotificationRecord;
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

// ---------- reports ----------

export interface ReportRecord {
  readonly id: string;
  /** Direct workspace scope for reports that are not tied to one repository (for example briefings). */
  readonly workspaceId: string | null;
  readonly repo: string | null;
  /** Issue/PR number this report is about (ci-analysis), if any. */
  readonly issueNumber: number | null;
  readonly kind: 'digest' | 'stale-sweep' | 'webhook' | 'ci-analysis' | 'briefing';
  readonly title: string;
  readonly body: string;
  readonly createdAt: number;
}

// ---------- notifications ----------

export type NotificationKind = 'action_required' | 'finished' | 'error' | 'info';

/** Inbox entry: workspaces report human-relevant events (action required, finished operations). */
export interface NotificationRecord {
  readonly id: string;
  /** Workspace the event belongs to; null = instance-wide. */
  readonly workspaceId: string | null;
  /** Repo access required to read this notification; null for workspace/platform events. */
  readonly repo: string | null;
  /**
   * Whom this concerns. null means everyone who can see the workspace, which is
   * every notification the product raised before this existed. A value narrows
   * the inbox to that person AND is what an outbound personal channel matches on.
   */
  readonly userId: string | null;
  readonly kind: NotificationKind;
  readonly title: string;
  readonly body: string;
  /** SPA hash link the notification opens. */
  readonly href: string | null;
  readonly readAt: number | null;
  readonly createdAt: number;
}
