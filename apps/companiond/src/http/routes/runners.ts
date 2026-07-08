import { z } from 'zod';
import { route, created, badRequest, notFound, type CompiledRoute } from '../router.js';
import { LOCAL_RUNNER_ID } from '../../store/db.js';
import type { ApiDeps } from '../deps.js';

const workspaceIds = z.array(z.string()).max(200).optional();

const createSchema = z.object({
  name: z.string().min(1).max(80),
  endpoint: z.string().url().max(300),
  token: z.string().min(1).max(400),
  scope: z.enum(['shared', 'delegated']).optional(),
  workspaceIds,
  maxRuns: z.number().int().min(1).max(64).optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  endpoint: z.string().url().max(300).optional(),
  token: z.string().min(1).max(400).optional(),
  scope: z.enum(['shared', 'delegated']).optional(),
  workspaceIds,
  maxRuns: z.number().int().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
});

/** Runners: execution machines. Admin-only (instance administration). */
export function runnerRoutes(deps: ApiDeps): CompiledRoute[] {
  return [
    route({
      method: 'GET',
      path: '/api/runners',
      access: 'runners:manage',
      handler: () => ({ runners: deps.runners.list() }),
    }),

    route({
      method: 'POST',
      path: '/api/runners',
      access: 'runners:manage',
      body: createSchema,
      handler: async ({ body }) => {
        if (body.scope === 'delegated' && (body.workspaceIds ?? []).length === 0) {
          throw badRequest('a delegated runner needs at least one workspace');
        }
        return created({ runner: await deps.runners.create(body) });
      },
    }),

    route({
      method: 'PATCH',
      path: '/api/runners/:id',
      access: 'runners:manage',
      body: updateSchema,
      handler: async ({ params, body }) => {
        if (!deps.runners.get(params.id)) throw notFound(`runner ${params.id} not found`);
        if (body.scope === 'delegated' && body.workspaceIds && body.workspaceIds.length === 0) {
          throw badRequest('a delegated runner needs at least one workspace');
        }
        return { runner: await deps.runners.update(params.id, body) };
      },
    }),

    route({
      method: 'DELETE',
      path: '/api/runners/:id',
      access: 'runners:manage',
      handler: ({ params }) => {
        if (params.id === LOCAL_RUNNER_ID) throw badRequest('the local runner cannot be deleted');
        if (!deps.runners.get(params.id)) throw notFound(`runner ${params.id} not found`);
        deps.runners.delete(params.id);
        return { ok: true };
      },
    }),

    /** Probe a runner's endpoint now — the "Test connection" action. */
    route({
      method: 'POST',
      path: '/api/runners/:id/probe',
      access: 'runners:manage',
      handler: async ({ params }) => {
        if (!deps.runners.get(params.id)) throw notFound(`runner ${params.id} not found`);
        return deps.runners.probeNow(params.id);
      },
    }),
  ];
}
