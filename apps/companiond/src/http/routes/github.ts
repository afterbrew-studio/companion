import { z } from 'zod';
import { route, created, badRequest, type CompiledRoute } from '../router.js';
import type { ApiDeps } from '../deps.js';

const purposesSchema = z.array(z.enum(['fetch', 'runs', 'pipelines', 'webhooks'])).min(1).max(4);
const scopeSchema = z.enum(['shared', 'delegated']);
const workspaceIdsSchema = z.array(z.string()).max(200);

const addAccountSchema = z.object({
  token: z.string().min(10).max(500),
  purposes: purposesSchema,
  scope: scopeSchema.default('shared'),
  workspaceIds: workspaceIdsSchema.default([]),
});

const patchAccountSchema = z.object({
  purposes: purposesSchema.optional(),
  scope: scopeSchema.optional(),
  workspaceIds: workspaceIdsSchema.optional(),
});

/**
 * Multiple GitHub accounts, each bound to what it does (fetches, runs,
 * pipelines, webhooks) and where it may act (shared, or delegated to specific
 * workspaces).
 */
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
        if (body.scope === 'delegated' && body.workspaceIds.length === 0) {
          throw badRequest('a delegated account needs at least one workspace');
        }
        const account = await deps.githubAccounts.add(body.token, body.purposes, body.scope, body.workspaceIds);
        deps.broadcast({ t: 'repos.changed' });
        return created({ account });
      },
    }),

    route({
      method: 'PATCH',
      path: '/api/github/accounts/:id',
      access: 'settings:manage',
      body: patchAccountSchema,
      handler: ({ params, body }) => {
        if (body.scope === 'delegated' && body.workspaceIds && body.workspaceIds.length === 0) {
          throw badRequest('a delegated account needs at least one workspace');
        }
        return { account: deps.githubAccounts.update(params.id, body) };
      },
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
