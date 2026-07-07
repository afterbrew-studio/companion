import { route, type CompiledRoute } from '../router.js';
import type { ApiDeps } from '../deps.js';

/** The inbox: workspace-scoped notifications (action required, finished operations). */
export function notificationRoutes(deps: ApiDeps): CompiledRoute[] {
  return [
    route({
      method: 'GET',
      path: '/api/notifications',
      access: 'workspaces:read',
      handler: ({ query }) => ({
        notifications: deps.store.notifications.list(query.get('workspace')),
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
      handler: ({ query }) => {
        deps.store.notifications.markAllRead(query.get('workspace'));
        deps.broadcast({ t: 'notifications.changed' });
        return { ok: true };
      },
    }),
  ];
}
