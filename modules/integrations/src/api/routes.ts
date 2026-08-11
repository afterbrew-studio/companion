import { z } from 'zod';
import type { AuthUser } from '@moxxy/companion-contracts';
import { badRequest, created, defineRoutes, notFound, route } from '@moxxy/companion-sdk/server';
import type { IntegrationScope } from '../contract/index.js';
import '../contract/index.js';

const scopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('instance') }),
  z.object({ kind: z.literal('workspace'), workspaceId: z.string().min(1).max(100) }),
  z.object({
    kind: z.literal('repository'),
    workspaceId: z.string().min(1).max(100),
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).max(300),
  }),
]);
// No z.number(): the field validator accepts only text and boolean values, so
// a number would pass the schema only to be rejected one layer down.
const configValue = z.union([z.string().max(4_000), z.boolean()]);
const connectionCreateSchema = z.object({
  providerId: z.string().min(3).max(120),
  name: z.string().trim().min(1).max(80),
  scope: scopeSchema,
  enabled: z.boolean().default(true),
  config: z.record(configValue).default({}),
});
const connectionPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    scope: scopeSchema.optional(),
    enabled: z.boolean().optional(),
    // null explicitly clears a value; omitted keeps the stored value/secret.
    config: z.record(z.union([configValue, z.null()])).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'at least one field is required');
const routeSchema = z.object({
  scope: scopeSchema,
  targets: z
    .array(
      z.object({
        providerId: z.string().min(3).max(120),
        connectionId: z.string().min(1).max(120).nullable(),
      }),
    )
    .max(8),
});

export default defineRoutes((ctx) => {
  const integrations = ctx.services.get('integrations');
  const workspaces = ctx.services.get('workspace');

  const requireScope = (user: AuthUser | null, scope: IntegrationScope): void => {
    if (scope.kind === 'instance') return;
    workspaces.requireAccessible(user, scope.workspaceId);
    if (scope.kind === 'repository') {
      const belongsToWorkspace = workspaces.repoNames(scope.workspaceId).includes(scope.repo);
      if (!belongsToWorkspace || !user || !workspaces.canAccessRepo(user, scope.repo)) {
        throw notFound(`repository ${scope.repo} not found`);
      }
    }
  };

  const canSeeScope = (user: AuthUser | null, scope: IntegrationScope): boolean => {
    if (scope.kind === 'instance') return true;
    if (!user || !workspaces.canAccessWorkspace(user, scope.workspaceId)) return false;
    return scope.kind === 'workspace' || (
      workspaces.repoNames(scope.workspaceId).includes(scope.repo) && workspaces.canAccessRepo(user, scope.repo)
    );
  };

  const shared = (user: AuthUser | null, id: string) => {
    const connection = integrations.getConnection(id);
    if (!connection || connection.ownerId !== null) throw notFound('integration connection not found');
    requireScope(user, connection.scope);
    return connection;
  };

  const mine = (user: AuthUser | null, id: string) => {
    const connection = integrations.getConnection(id);
    if (!connection || !user || connection.ownerId !== user.username) {
      throw notFound('integration connection not found');
    }
    requireScope(user, connection.scope);
    return connection;
  };

  const execute = <T>(work: () => T): T => {
    try {
      return work();
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : String(error));
    }
  };

  const executeAsync = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : String(error));
    }
  };

  const scopeFromQuery = (query: URLSearchParams): IntegrationScope => {
    const kind = query.get('scope') ?? 'instance';
    if (kind === 'instance') return { kind: 'instance' };
    const workspaceId = query.get('workspaceId')?.trim();
    if (!workspaceId) throw badRequest('workspaceId is required for this scope');
    if (kind === 'workspace') return { kind: 'workspace', workspaceId };
    if (kind === 'repository') {
      const repo = query.get('repo')?.trim();
      if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw badRequest('repo must be owner/name');
      return { kind: 'repository', workspaceId, repo };
    }
    throw badRequest(`unknown integration scope '${kind}'`);
  };

  return [
    route({
      method: 'GET',
      path: '/api/integrations/catalog',
      access: 'integrations:read',
      handler: ({ user }) => {
        const canManage = !!user && ctx.rbac.allows(user, 'integrations:manage');
        // Managers also see other users' personal connections (owner shown in
        // the UI) so orphans and policy violations are visible and removable.
        const catalog = integrations.catalog(user?.username ?? null, canManage);
        return {
          ...catalog,
          connections: catalog.connections
            .filter((connection) => canSeeScope(user, connection.scope))
            .map((connection) =>
              canManage || connection.ownerId === user?.username
                ? connection
                : { ...connection, config: {}, configuredSecrets: [] },
            ),
        };
      },
    }),

    route({
      method: 'POST',
      path: '/api/integrations/connections',
      access: 'integrations:manage',
      body: connectionCreateSchema,
      handler: ({ body, user }) => {
        requireScope(user, body.scope);
        return created({ connection: execute(() => integrations.createConnection(body, null)) });
      },
    }),
    route({
      method: 'POST',
      path: '/api/integrations/connections/mine',
      access: 'integrations:self',
      body: connectionCreateSchema,
      handler: ({ body, user }) => {
        if (!user) throw badRequest('a personal connection needs a signed-in owner');
        requireScope(user, body.scope);
        return created({ connection: execute(() => integrations.createConnection(body, user.username)) });
      },
    }),

    route({
      method: 'PATCH',
      path: '/api/integrations/connections/:id',
      access: 'integrations:manage',
      body: connectionPatchSchema,
      handler: ({ params, body, user }) => {
        shared(user, params.id);
        if (body.scope) requireScope(user, body.scope);
        return { connection: execute(() => integrations.updateConnection(params.id, body)) };
      },
    }),
    route({
      method: 'PATCH',
      path: '/api/integrations/connections/mine/:id',
      access: 'integrations:self',
      body: connectionPatchSchema,
      handler: ({ params, body, user }) => {
        mine(user, params.id);
        if (body.scope) requireScope(user, body.scope);
        return { connection: execute(() => integrations.updateConnection(params.id, body)) };
      },
    }),

    route({
      method: 'DELETE',
      path: '/api/integrations/connections/:id',
      access: 'integrations:manage',
      handler: ({ params, user }) => {
        // Unlike the other shared-connection routes, managers may also delete
        // ANY personal connection (cleanup of orphans and policy violations).
        // Non-managers never reach here, so the 404-hiding of personal
        // connections from them is unchanged.
        const connection = integrations.getConnection(params.id);
        if (!connection) throw notFound('integration connection not found');
        requireScope(user, connection.scope);
        integrations.removeConnection(params.id);
        return { ok: true };
      },
    }),
    route({
      method: 'DELETE',
      path: '/api/integrations/connections/mine/:id',
      access: 'integrations:self',
      handler: ({ params, user }) => {
        mine(user, params.id);
        integrations.removeConnection(params.id);
        return { ok: true };
      },
    }),

    route({
      method: 'POST',
      path: '/api/integrations/connections/:id/test',
      access: 'integrations:manage',
      handler: async ({ params, user }) => {
        shared(user, params.id);
        return { connection: await executeAsync(() => integrations.testConnection(params.id)) };
      },
    }),
    route({
      method: 'POST',
      path: '/api/integrations/connections/mine/:id/test',
      access: 'integrations:self',
      handler: async ({ params, user }) => {
        mine(user, params.id);
        return { connection: await executeAsync(() => integrations.testConnection(params.id)) };
      },
    }),

    route({
      method: 'GET',
      path: '/api/integrations/routes/:capability',
      access: 'integrations:read',
      handler: ({ params, query, user }) => {
        const scope = scopeFromQuery(query);
        requireScope(user, scope);
        return { route: integrations.effectiveRoute(params.capability, scope) };
      },
    }),
    route({
      method: 'PUT',
      path: '/api/integrations/routes/:capability',
      access: 'integrations:manage',
      body: routeSchema,
      handler: ({ params, body, user }) => {
        requireScope(user, body.scope);
        return { route: execute(() => integrations.setRoute(params.capability, body.scope, body.targets)) };
      },
    }),
  ];
});
