import { z } from 'zod';
import { route, created, badRequest, notFound, type CompiledRoute } from '../router.js';
import type { ApiDeps } from '../deps.js';

const storageSchema = z.enum(['virtual', 'repo']).optional();

const saveDocSchema = z.object({
  repo: z.string().nullish(),
  title: z.string().min(3).max(200),
  content: z.string().min(1).max(512_000),
  storage: storageSchema,
});

const configSchema = z.object({
  dir: z.string().min(1).max(120).nullable(),
});

const patchDocSchema = z.object({
  title: z.string().min(3).max(200).optional(),
  content: z.string().min(1).max(512_000).optional(),
  repo: z.string().nullish(),
});

const importDocsSchema = z.object({
  repo: z.string(),
  paths: z.array(z.string().min(1).max(500)).min(1).max(200),
});

const generateDocSchema = z.object({
  repo: z.string().optional(),
  instructions: z.string().min(8).max(4000),
  storage: storageSchema,
});

/** Documentation: workspace knowledge CRUD, repo imports, retrieval search. */
export function docRoutes(deps: ApiDeps): CompiledRoute[] {
  const requireWorkspace = (id: string) => {
    const ws = deps.store.workspaces.get(id);
    if (!ws) throw notFound(`workspace ${id} not found`);
    return ws;
  };
  const requireDoc = (id: string) => {
    const doc = deps.docs.get(id);
    if (!doc) throw notFound(`doc ${id} not found`);
    return doc;
  };
  const requireRepo = (fullName: string) => {
    if (!deps.store.repos.get(fullName)) throw badRequest(`repo ${fullName} not connected`);
  };

  return [
    route({
      method: 'GET',
      path: '/api/workspaces/:id/docs',
      access: 'docs:read',
      handler: ({ params }) => {
        requireWorkspace(params.id);
        return { docs: deps.docs.list(params.id) };
      },
    }),

    route({
      method: 'GET',
      path: '/api/workspaces/:id/docs/search',
      access: 'docs:read',
      handler: ({ params, query }) => {
        requireWorkspace(params.id);
        const q = query.get('q') ?? '';
        const limit = Math.min(Number(query.get('limit')) || 8, 25);
        return { hits: deps.docs.search(params.id, q, limit) };
      },
    }),

    route({
      method: 'GET',
      path: '/api/docs/:id',
      access: 'docs:read',
      handler: ({ params }) => ({ doc: requireDoc(params.id) }),
    }),

    // ---------- storage configuration (first-visit setup) ---------------------

    route({
      method: 'GET',
      path: '/api/workspaces/:id/docs-config',
      access: 'docs:read',
      handler: ({ params }) => {
        requireWorkspace(params.id);
        return deps.docs.storageState(params.id);
      },
    }),

    route({
      method: 'PUT',
      path: '/api/workspaces/:id/docs-config',
      access: 'docs:manage',
      body: configSchema,
      handler: ({ params, body }) => {
        requireWorkspace(params.id);
        try {
          return deps.docs.configure(params.id, body.dir);
        } catch (err) {
          throw badRequest(String(err instanceof Error ? err.message : err));
        }
      },
    }),

    route({
      method: 'POST',
      path: '/api/workspaces/:id/docs',
      access: 'docs:manage',
      body: saveDocSchema,
      handler: ({ params, body }) => {
        requireWorkspace(params.id);
        if (body.repo) requireRepo(body.repo);
        return created({ doc: deps.docs.create(params.id, { ...body, repo: body.repo ?? null }) });
      },
    }),

    route({
      method: 'PATCH',
      path: '/api/docs/:id',
      access: 'docs:manage',
      body: patchDocSchema,
      handler: ({ params, body }) => {
        requireDoc(params.id);
        if (body.repo) requireRepo(body.repo);
        return { doc: deps.docs.update(params.id, body) };
      },
    }),

    route({
      method: 'DELETE',
      path: '/api/docs/:id',
      access: 'docs:manage',
      handler: ({ params }) => {
        requireDoc(params.id);
        deps.docs.remove(params.id);
        return { ok: true };
      },
    }),

    route({
      method: 'GET',
      path: '/api/repos/:owner/:name/doc-files',
      access: 'docs:read',
      handler: ({ params }) => {
        const fullName = `${params.owner}/${params.name}`;
        requireRepo(fullName);
        return { files: deps.docs.importCandidates(fullName) };
      },
    }),

    route({
      method: 'POST',
      path: '/api/workspaces/:id/docs/import',
      access: 'docs:manage',
      body: importDocsSchema,
      handler: ({ params, body }) => {
        requireWorkspace(params.id);
        requireRepo(body.repo);
        return created({ docs: deps.docs.importFromRepo(params.id, body.repo, body.paths) });
      },
    }),

    // Synchronous like skill drafts: the modal waits while the agent writes.
    route({
      method: 'POST',
      path: '/api/workspaces/:id/docs/generate',
      access: 'docs:manage',
      body: generateDocSchema,
      handler: async ({ params, body }) => {
        requireWorkspace(params.id);
        if (body.repo) requireRepo(body.repo);
        try {
          return created({ doc: await deps.docs.generate(params.id, body) });
        } catch (err) {
          throw badRequest(
            err instanceof z.ZodError
              ? 'the agent reply was not a valid doc draft — try rephrasing'
              : String(err instanceof Error ? err.message : err),
          );
        }
      },
    }),
  ];
}
