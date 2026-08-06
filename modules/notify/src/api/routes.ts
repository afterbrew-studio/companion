import { defineRoutes, route } from '@moxxy/companion-sdk/server';
import type { IntegrationScope } from '@companion/module-integrations/contract';
import '../contract/index.js';

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
      handler: ({ user }) => {
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
        return { deliveries: notify.deliveriesFor(user?.username ?? null, scopes) };
      },
    }),
  ];
});
