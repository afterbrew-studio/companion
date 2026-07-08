import { route, type CompiledRoute } from '../router.js';
import type { ApiDeps } from '../deps.js';
import type { AuthUser } from '@companion/contract';

/** The inbox: workspace-scoped notifications (action required, finished operations). */
export function notificationRoutes(deps: ApiDeps): CompiledRoute[] {
  // A requested workspace only counts if the user may see it; otherwise fall
  // back to instance-wide only, so a private workspace's inbox never leaks.
  const scopeFor = (user: AuthUser | null, workspaceId: string | null): string | null => {
    if (!workspaceId || !user) return null;
    const ws = deps.store.workspaces.get(workspaceId);
    return ws && deps.store.workspaces.canAccess(user, ws) ? workspaceId : null;
  };

  return [
    route({
      method: 'GET',
      path: '/api/notifications',
      access: 'workspaces:read',
      handler: ({ query, user }) => ({
        notifications: deps.store.notifications.list(scopeFor(user, query.get('workspace'))),
      }),
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
        deps.store.notifications.markAllRead(scopeFor(user, query.get('workspace')));
        deps.broadcast({ t: 'notifications.changed' });
        return { ok: true };
      },
    }),
  ];
}
