import { badRequest, defineRoutes, route } from '@moxxy/companion-sdk/server';
import type { IntegrationScope } from '@companion/module-integrations/contract';
import '../contract/index.js';

const MAX_DELIVERIES_LIMIT = 500;

export default defineRoutes((ctx) => {
  const notify = ctx.services.get('notify');
  const workspaces = ctx.services.get('workspace');
  return [
    route({
      method: 'GET',
      path: '/api/notify/deliveries',
      access: 'notify:read',
      // Ownership and workspace/repository visibility both apply. Holding the
      // diagnostic permission must not reveal another team's notification
      // titles or connection names.
      handler: ({ user, query }) => {
        const limitParam = query.get('limit');
        const limit = limitParam === null ? undefined : Number(limitParam);
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > MAX_DELIVERIES_LIMIT)) {
          throw badRequest(`limit must be an integer between 1 and ${MAX_DELIVERIES_LIMIT}`);
        }
        const scopes: IntegrationScope[] = [{ kind: 'instance' }];
        if (user) {
          for (const workspaceId of workspaces.accessibleIds(user)) {
            scopes.push({ kind: 'workspace', workspaceId });
            for (const repo of workspaces.repoNames(workspaceId)) {
              if (workspaces.canAccessRepo(user, repo)) {
                scopes.push({ kind: 'repository', workspaceId, repo });
              }
            }
          }
        }
        return { deliveries: notify.deliveriesFor(user?.username ?? null, scopes, limit) };
      },
    }),
  ];
});
