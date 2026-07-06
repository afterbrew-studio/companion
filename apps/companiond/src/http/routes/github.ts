import { z } from 'zod';
import { route, created, type CompiledRoute } from '../router.js';
import type { ApiDeps } from '../deps.js';

const purposesSchema = z.array(z.enum(['fetch', 'runs', 'pipelines', 'webhooks'])).min(1).max(4);

const addAccountSchema = z.object({
  token: z.string().min(10).max(500),
  purposes: purposesSchema,
});

/** Multiple GitHub accounts, each bound to what it does (fetches, runs, pipelines, webhooks). */
export function githubRoutes(deps: ApiDeps): CompiledRoute[] {
  return [
    route({
      // Sanitized list (no tokens) — repo cards and detail pages render "act as" pickers.
      method: 'GET',
      path: '/api/github/accounts',
      access: 'repos:read',
      handler: () => ({ accounts: deps.githubAccounts.list() }),
    }),

    route({
      method: 'POST',
      path: '/api/github/accounts',
      access: 'settings:manage',
      body: addAccountSchema,
      handler: async ({ body }) => {
        const account = await deps.githubAccounts.add(body.token, body.purposes);
        deps.broadcast({ t: 'repos.changed' });
        return created({ account });
      },
    }),

    route({
      method: 'PATCH',
      path: '/api/github/accounts/:id',
      access: 'settings:manage',
      body: z.object({ purposes: purposesSchema }),
      handler: ({ params, body }) => ({ account: deps.githubAccounts.setPurposes(params.id, body.purposes) }),
    }),

    route({
      method: 'DELETE',
      path: '/api/github/accounts/:id',
      access: 'settings:manage',
      handler: ({ params }) => {
        deps.githubAccounts.remove(params.id);
        deps.broadcast({ t: 'repos.changed' });
        return { ok: true };
      },
    }),
  ];
}
