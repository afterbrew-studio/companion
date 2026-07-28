import { del, patch, post, qs, request } from '@moxxy/companion-sdk/client';
import type {
  NotificationRecord,
  ReportRecord,
  WorkspaceMember,
  WorkspaceMemberCandidate,
  WorkspaceMetrics,
  WorkspaceRecord,
  WorkspaceVisibility,
} from '../contract/index.js';

/**
 * module-workspace's REST surface, carved from the legacy `lib/api.ts`: the
 * workspaces CRUD + membership + metrics family, the notification inbox, and
 * the generated-reports feed. HTTP plumbing lives in `@moxxy/companion-core/client`.
 */

export const workspaceApi = {
  // workspaces
  listWorkspaces: () => request<{ workspaces: WorkspaceRecord[] }>('/api/workspaces'),
  createWorkspace: (name: string, opts?: { description?: string; visibility?: WorkspaceVisibility }) =>
    post<{ workspace: WorkspaceRecord }>('/api/workspaces', { name, ...opts }),
  updateWorkspace: (
    id: string,
    fields: { name?: string; description?: string; visibility?: WorkspaceVisibility },
  ) => patch<{ workspace: WorkspaceRecord }>(`/api/workspaces/${id}`, fields),
  deleteWorkspace: (id: string) => del<{ ok: true }>(`/api/workspaces/${id}`),

  // private-workspace membership
  listWorkspaceMembers: (id: string) =>
    request<{ members: WorkspaceMember[] }>(`/api/workspaces/${id}/members`),
  workspaceMemberCandidates: (id: string, q: string) =>
    request<{ candidates: WorkspaceMemberCandidate[] }>(
      `/api/workspaces/${id}/member-candidates${qs({ q: q || undefined })}`,
    ),
  addWorkspaceMember: (id: string, username: string) =>
    post<{ members: WorkspaceMember[] }>(`/api/workspaces/${id}/members`, { username }),
  removeWorkspaceMember: (id: string, username: string) =>
    del<{ members: WorkspaceMember[] }>(`/api/workspaces/${id}/members/${encodeURIComponent(username)}`),

  // dashboard metrics
  workspaceMetrics: (id: string) => request<{ metrics: WorkspaceMetrics }>(`/api/workspaces/${id}/metrics`),

  // notifications
  listNotifications: (workspaceId?: string) =>
    request<{ notifications: NotificationRecord[] }>(
      `/api/notifications${workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : ''}`,
    ),
  markNotificationRead: (id: string) => post<{ ok: true }>(`/api/notifications/${id}/read`),
  markAllNotificationsRead: (workspaceId?: string) =>
    post<{ ok: true }>(`/api/notifications/read-all${workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : ''}`),

  // reports
  listReports: () => request<{ reports: ReportRecord[] }>('/api/reports'),
};
