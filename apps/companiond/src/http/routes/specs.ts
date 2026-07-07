import { z } from 'zod';
import { route, created, accepted, badRequest, notFound, type CompiledRoute } from '../router.js';
import { log } from '../../log.js';
import type { ApiDeps } from '../deps.js';

const storageSchema = z.enum(['virtual', 'repo']).optional();

const createSpecSchema = z.object({
  repo: z.string(),
  title: z.string().min(3).max(200),
  content: z.string().min(1).max(256_000),
  storage: storageSchema,
});

const configSchema = z.object({
  dir: z.string().min(1).max(120).nullable(),
});

const patchSpecSchema = z.object({
  title: z.string().min(3).max(200).optional(),
  content: z.string().min(1).max(256_000).optional(),
});

const generateSpecSchema = z.object({
  repo: z.string(),
  instructions: z.string().min(8).max(4000),
  storage: storageSchema,
});

const createFeatureSchema = z.object({
  title: z.string().min(3).max(200).optional(),
  notes: z.string().max(10_000).optional(),
});

/** Specifications: repo-grounded spec documents + the spec → feature bridge. */
export function specRoutes(deps: ApiDeps): CompiledRoute[] {
  const requireSpec = (id: string) => {
    const spec = deps.store.specs.get(id);
    if (!spec) throw notFound(`spec ${id} not found`);
    return spec;
  };

  return [
    route({
      method: 'GET',
      path: '/api/workspaces/:id/specs',
      access: 'specs:read',
      handler: ({ params }) => {
        if (!deps.store.workspaces.get(params.id)) throw notFound(`workspace ${params.id} not found`);
        return { specs: deps.specs.list(params.id) };
      },
    }),

    route({
      method: 'GET',
      path: '/api/specs/:id',
      access: 'specs:read',
      handler: ({ params }) => ({ spec: requireSpec(params.id) }),
    }),

    // ---------- storage configuration (first-visit setup) ---------------------

    route({
      method: 'GET',
      path: '/api/workspaces/:id/specs-config',
      access: 'specs:read',
      handler: ({ params }) => {
        if (!deps.store.workspaces.get(params.id)) throw notFound(`workspace ${params.id} not found`);
        return deps.specs.storageState(params.id);
      },
    }),

    route({
      method: 'PUT',
      path: '/api/workspaces/:id/specs-config',
      access: 'specs:manage',
      body: configSchema,
      handler: ({ params, body }) => {
        if (!deps.store.workspaces.get(params.id)) throw notFound(`workspace ${params.id} not found`);
        try {
          return deps.specs.configure(params.id, body.dir);
        } catch (err) {
          throw badRequest(String(err instanceof Error ? err.message : err));
        }
      },
    }),

    route({
      method: 'POST',
      path: '/api/specs',
      access: 'specs:manage',
      body: createSpecSchema,
      handler: ({ body }) => {
        if (!deps.store.repos.get(body.repo)) throw badRequest(`repo ${body.repo} not connected`);
        try {
          return created({ spec: deps.specs.create(body.repo, body.title, body.content, body.storage) });
        } catch (err) {
          throw badRequest(String(err instanceof Error ? err.message : err));
        }
      },
    }),

    route({
      method: 'PATCH',
      path: '/api/specs/:id',
      access: 'specs:manage',
      body: patchSpecSchema,
      handler: ({ params, body }) => {
        requireSpec(params.id);
        return { spec: deps.specs.update(params.id, body) };
      },
    }),

    route({
      method: 'DELETE',
      path: '/api/specs/:id',
      access: 'specs:manage',
      handler: ({ params }) => {
        requireSpec(params.id);
        deps.specs.remove(params.id);
        return { ok: true };
      },
    }),

    route({
      method: 'POST',
      path: '/api/specs/generate',
      access: 'specs:manage',
      body: generateSpecSchema,
      handler: ({ body }) => {
        if (!deps.store.repos.get(body.repo)) throw badRequest(`repo ${body.repo} not connected`);
        void deps.specs
          .generate(body.repo, body.instructions, body.storage)
          .catch((err) => log.warn('spec generation failed', { repo: body.repo, err: String(err) }));
        return accepted({ queued: true });
      },
    }),

    route({
      method: 'POST',
      path: '/api/specs/:id/dismiss-drift',
      access: 'specs:manage',
      handler: ({ params }) => {
        requireSpec(params.id);
        deps.specs.dismissDrift(params.id);
        return { ok: true };
      },
    }),

    // The knowledge flywheel's other half: an implemented proposal becomes a
    // spec of the now-current behavior (async — a drafting agent runs).
    route({
      method: 'POST',
      path: '/api/proposals/:id/capture-spec',
      access: 'specs:manage',
      handler: ({ params }) => {
        const proposal = deps.store.proposals.get(params.id);
        if (!proposal) throw notFound(`proposal ${params.id} not found`);
        if (proposal.status !== 'implemented') throw badRequest(`proposal is ${proposal.status}, not implemented`);
        void deps.specs
          .generate(
            proposal.repo,
            `Document, as a specification of the CURRENT behavior, the feature implemented by the proposal "${proposal.title}". Original proposal:\n${proposal.body.slice(0, 2000)}`,
          )
          .catch((err) => log.warn('capture-spec failed', { proposal: params.id, err: String(err) }));
        return accepted({ queued: true });
      },
    }),

    // Filing a feature from a spec is proposal creation — same capability the
    // business role uses to file one by hand.
    route({
      method: 'POST',
      path: '/api/specs/:id/create-feature',
      access: 'proposals:create',
      body: createFeatureSchema,
      handler: ({ params, body }) => {
        requireSpec(params.id);
        return created({ proposal: deps.specs.createFeature(params.id, body) });
      },
    }),
  ];
}
