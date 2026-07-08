import { route, type CompiledRoute } from '../router.js';
import type { ApiDeps } from '../deps.js';
import type { AuthUser } from '@companion/contract';

/** The inbox: workspace-scoped notifications (action required, finished operations). */
export function notificationRoutes(deps: ApiDeps): CompiledRoute[] {
  // Resolve the notification scope for a user. A specific, accessible workspace
  // → just that one (+ instance-wide). Otherwise fall back to everything the
  // user can see: admins get all workspaces (undefined = unrestricted), others
  // get instance-wide + their accessible workspaces — so a private workspace's
  // inbox never leaks, even via the no-workspace path.
  const scope = (
    user: AuthUser | null,
    workspaceId: string | null,
  ): { workspaceId: string | null; accessibleIds?: readonly string[] } => {
    if (workspaceId && user) {
      const ws = deps.store.workspaces.get(workspaceId);
      if (ws && deps.store.workspaces.canAccess(user, ws)) return { workspaceId };
    }
    if (!user || user.role === 'admin') return { workspaceId: null };
    return { workspaceId: null, accessibleIds: [...deps.store.workspaces.accessibleIds(user)] };
  };

  return [
    route({
      method: 'GET',
      path: '/api/notifications',
      access: 'workspaces:read',
      handler: ({ query, user }) => {
        const s = scope(user, query.get('workspace'));
        return { notifications: deps.store.notifications.list(s.workspaceId, 100, s.accessibleIds) };
      },
    }),

    route({
      method: 'POST',
      path: '/api/notifications/:id/read',
      access: 'workspaces:read',
      handler: ({ params }) => {
        deps.store.notifications.markRead(params.id);
        deps.broadcast({ t: 'notifications.changed' });
        return { ok: true };
      },
    }),

    route({
      method: 'POST',
      path: '/api/notifications/read-all',
      access: 'workspaces:read',
      handler: ({ query, user }) => {
        const s = scope(user, query.get('workspace'));
        deps.store.notifications.markAllRead(s.workspaceId, s.accessibleIds);
        deps.broadcast({ t: 'notifications.changed' });
        return { ok: true };
      },
    }),
  ];
}
