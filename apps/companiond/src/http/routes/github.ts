import { z } from 'zod';
import type { AuthUser } from '@companion/contract';
import { route, created, badRequest, forbidden, notFound, type CompiledRoute } from '../router.js';
import type { ApiDeps } from '../deps.js';

const purposesSchema = z.array(z.enum(['fetch', 'runs', 'pipelines', 'webhooks'])).min(1).max(4);
const scopeSchema = z.enum(['shared', 'delegated']);
const workspaceIdsSchema = z.array(z.string()).max(200);

const addAccountSchema = z.object({
  token: z.string().min(10).max(500),
  purposes: purposesSchema,
  scope: scopeSchema.default('shared'),
  workspaceIds: workspaceIdsSchema.default([]),
  /** Admin-only: make this a shared default account (usable by everyone) rather than personal. */
  shared: z.boolean().default(false),
});

const patchAccountSchema = z.object({
  purposes: purposesSchema.optional(),
  scope: scopeSchema.optional(),
  workspaceIds: workspaceIdsSchema.optional(),
});

/**
 * GitHub accounts. Maintainers may connect and manage their OWN account
 * (github:connect); admins manage all and own the shared default accounts.
 * When a user invokes an action, their own account is preferred; otherwise a
 * shared default is used.
 */
export function githubRoutes(deps: ApiDeps): CompiledRoute[] {
  // Manage gate: an account's owner, or any admin.
  const requireManageable = (user: AuthUser | null, id: string) => {
    const row = deps.githubAccounts.row(id);
    if (!row) throw notFound(`GitHub account ${id} not found`);
    if (!user || (user.role !== 'admin' && row.ownerId !== user.username)) {
      throw forbidden('you can only manage your own GitHub account');
    }
    return row;
  };

  return [
    route({
      // Sanitized list (no tokens): shared defaults + the caller's own; admins see all.
      method: 'GET',
      path: '/api/github/accounts',
      access: 'repos:read',
      handler: ({ user }) => {
        const all = deps.githubAccounts.list();
        const accounts =
          user?.role === 'admin'
            ? all
            : all.filter((a) => a.ownerId === null || a.ownerId === user?.username);
        return { accounts };
      },
    }),

    route({
      method: 'POST',
      path: '/api/github/accounts',
      access: 'github:connect',
      body: addAccountSchema,
      handler: async ({ body, user }) => {
        if (body.scope === 'delegated' && body.workspaceIds.length === 0) {
          throw badRequest('a delegated account needs at least one workspace');
        }
        // A shared default account is admin-only; everyone else's is personal.
        const ownerId = user!.role === 'admin' && body.shared ? null : user!.username;
        const account = await deps.githubAccounts.add(body.token, body.purposes, body.scope, body.workspaceIds, ownerId);
        deps.broadcast({ t: 'repos.changed' });
        return created({ account });
      },
    }),

    route({
      method: 'PATCH',
      path: '/api/github/accounts/:id',
      access: 'github:connect',
      body: patchAccountSchema,
      handler: ({ params, body, user }) => {
        requireManageable(user, params.id);
        if (body.scope === 'delegated' && body.workspaceIds && body.workspaceIds.length === 0) {
          throw badRequest('a delegated account needs at least one workspace');
        }
        return { account: deps.githubAccounts.update(params.id, body) };
      },
    }),

    route({
      method: 'DELETE',
      path: '/api/github/accounts/:id',
      access: 'github:connect',
      handler: ({ params, user }) => {
        requireManageable(user, params.id);
        deps.githubAccounts.remove(params.id);
        deps.broadcast({ t: 'repos.changed' });
        return { ok: true };
      },
    }),
  ];
}
