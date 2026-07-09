import { z } from 'zod';
import { defineRoutes, route, created, accepted, badRequest, notFound } from '@companion/core/server';
import type { AuthUser } from '@companion/contracts';
import type { WorkspaceRecord } from '@companion/module-workspace/contract';
import { log } from '@companion/services';
import '../contract/index.js';
import { ProposalsStore } from './proposals-store.js';
import { SpecsStore } from './specs-store.js';

// ---------- proposals ----------

const proposalSchema = z.object({
  repo: z.string(),
  title: z.string().min(3).max(200),
  body: z.string().min(1),
});

// ---------- specs ----------

const storageSchema = z.enum(['virtual', 'repo']).optional();

const createSpecSchema = z.object({
  repo: z.string(),
  title: z.string().min(3).max(200),
  content: z.string().min(1).max(256_000),
  storage: storageSchema,
});

const specConfigSchema = z.object({
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

// ---------- docs ----------

const saveDocSchema = z.object({
  repo: z.string().nullish(),
  title: z.string().min(3).max(200),
  content: z.string().min(1).max(512_000),
  storage: storageSchema,
});

const docConfigSchema = z.object({
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

/**
 * The plan domain's HTTP surface: proposals and their analyze → approve →
 * implement lifecycle (+ the workspace proposals feed), specifications (CRUD,
 * storage configuration, drift, the spec ↔ proposal bridges) and documentation
 * (CRUD, storage configuration, repo imports, retrieval search).
 */
export default defineRoutes((ctx) => {
  const plan = ctx.services.get('plan');
  const code = ctx.services.get('code');
  const workspace = ctx.services.get('workspace');

  // Read-side lookups the service bundle doesn't re-expose (rows by id /
  // instance-wide lists). Store classes are stateless wrappers over ctx.db, so
  // these instances read exactly what the services write.
  const proposalsStore = new ProposalsStore(ctx.db);
  const specsStore = new SpecsStore(ctx.db);

  const requireSpec = (id: string) => {
    const spec = specsStore.get(id);
    if (!spec) throw notFound(`spec ${id} not found`);
    return spec;
  };
  const requireDoc = (id: string) => {
    const doc = plan.docs.get(id);
    if (!doc) throw notFound(`doc ${id} not found`);
    return doc;
  };
  const requireRepo = (fullName: string) => {
    if (!code.repos.get(fullName)) throw badRequest(`repo ${fullName} not connected`);
  };

  // Access gate for the workspace proposals feed: a private workspace the user
  // isn't in reads as "not found" — same helper as module-workspace's routes.
  const requireWorkspace = (user: AuthUser | null, id: string): WorkspaceRecord => {
    const ws = workspace.get(id);
    if (!ws || !user || !workspace.canAccess(user, ws)) {
      throw notFound(`workspace ${id} not found`);
    }
    return ws;
  };

  // The spec/doc routes only assert existence (legacy behavior).
  const requireWorkspaceExists = (id: string): WorkspaceRecord => {
    const ws = workspace.get(id);
    if (!ws) throw notFound(`workspace ${id} not found`);
    return ws;
  };

  return [
    // ---------- proposals ----------------------------------------------------------

    route({
      method: 'GET',
      path: '/api/proposals',
      access: 'proposals:read',
      handler: () => ({ proposals: proposalsStore.list() }),
    }),

    route({
      method: 'POST',
      path: '/api/proposals',
      access: 'proposals:create',
      body: proposalSchema,
      handler: ({ body }) => {
        if (!code.repos.get(body.repo)) throw badRequest(`repo ${body.repo} not connected`);
        return created({ proposal: plan.proposals.create(body.repo, body.title, body.body) });
      },
    }),

    // Analysis is read-only and part of filing a proposal, so it rides
    // proposals:create — business users see feasibility before a maintainer
    // ever gets involved.
    route({
      method: 'POST',
      path: '/api/proposals/:id/analyze',
      access: 'proposals:create',
      handler: ({ params }) => {
        void plan.proposals
          .analyze(params.id)
          .catch((err) => log.warn('analysis failed', { id: params.id, err: String(err) }));
        return accepted({ queued: true });
      },
    }),

    route({
      method: 'POST',
      path: '/api/proposals/:id/approve',
      access: 'proposals:act',
      handler: async ({ params }) => ({ proposal: await plan.proposals.approve(params.id) }),
    }),

    route({
      method: 'POST',
      path: '/api/proposals/:id/finish',
      access: 'proposals:act',
      handler: async ({ params }) => ({ proposal: await plan.proposals.finishImplementation(params.id) }),
    }),

    route({
      method: 'POST',
      path: '/api/proposals/:id/reject',
      access: 'proposals:act',
      handler: ({ params }) => {
        plan.proposals.reject(params.id);
        return { ok: true };
      },
    }),

    // The workspace area feed (plan-owned cross-domain read).
    route({
      method: 'GET',
      path: '/api/workspaces/:id/proposals',
      access: 'proposals:read',
      handler: ({ params, user }) => {
        requireWorkspace(user, params.id);
        return { proposals: proposalsStore.listWorkspace(params.id) };
      },
    }),

    // ---------- specs ---------------------------------------------------------------

    route({
      method: 'GET',
      path: '/api/workspaces/:id/specs',
      access: 'specs:read',
      handler: ({ params }) => {
        requireWorkspaceExists(params.id);
        return { specs: plan.specs.list(params.id) };
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
        requireWorkspaceExists(params.id);
        return plan.specs.storageState(params.id);
      },
    }),

    route({
      method: 'PUT',
      path: '/api/workspaces/:id/specs-config',
      access: 'specs:manage',
      body: specConfigSchema,
      handler: ({ params, body }) => {
        requireWorkspaceExists(params.id);
        try {
          return plan.specs.configure(params.id, body.dir);
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
        requireRepo(body.repo);
        try {
          return created({ spec: plan.specs.create(body.repo, body.title, body.content, body.storage) });
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
        return { spec: plan.specs.update(params.id, body) };
      },
    }),

    route({
      method: 'DELETE',
      path: '/api/specs/:id',
      access: 'specs:manage',
      handler: ({ params }) => {
        requireSpec(params.id);
        plan.specs.remove(params.id);
        return { ok: true };
      },
    }),

    route({
      method: 'POST',
      path: '/api/specs/generate',
      access: 'specs:manage',
      body: generateSpecSchema,
      handler: ({ body }) => {
        requireRepo(body.repo);
        void plan.specs
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
        plan.specs.dismissDrift(params.id);
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
        const proposal = proposalsStore.get(params.id);
        if (!proposal) throw notFound(`proposal ${params.id} not found`);
        if (proposal.status !== 'implemented') throw badRequest(`proposal is ${proposal.status}, not implemented`);
        void plan.specs
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
        return created({ proposal: plan.specs.createFeature(params.id, body) });
      },
    }),

    // ---------- docs ----------------------------------------------------------------

    route({
      method: 'GET',
      path: '/api/workspaces/:id/docs',
      access: 'docs:read',
      handler: ({ params }) => {
        requireWorkspaceExists(params.id);
        return { docs: plan.docs.list(params.id) };
      },
    }),

    route({
      method: 'GET',
      path: '/api/workspaces/:id/docs/search',
      access: 'docs:read',
      handler: ({ params, query }) => {
        requireWorkspaceExists(params.id);
        const q = query.get('q') ?? '';
        const limit = Math.min(Number(query.get('limit')) || 8, 25);
        return { hits: plan.docs.search(params.id, q, limit) };
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
        requireWorkspaceExists(params.id);
        return plan.docs.storageState(params.id);
      },
    }),

    route({
      method: 'PUT',
      path: '/api/workspaces/:id/docs-config',
      access: 'docs:manage',
      body: docConfigSchema,
      handler: ({ params, body }) => {
        requireWorkspaceExists(params.id);
        try {
          return plan.docs.configure(params.id, body.dir);
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
        requireWorkspaceExists(params.id);
        if (body.repo) requireRepo(body.repo);
        return created({ doc: plan.docs.create(params.id, { ...body, repo: body.repo ?? null }) });
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
        return { doc: plan.docs.update(params.id, body) };
      },
    }),

    route({
      method: 'DELETE',
      path: '/api/docs/:id',
      access: 'docs:manage',
      handler: ({ params }) => {
        requireDoc(params.id);
        plan.docs.remove(params.id);
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
        return { files: plan.docs.importCandidates(fullName) };
      },
    }),

    route({
      method: 'POST',
      path: '/api/workspaces/:id/docs/import',
      access: 'docs:manage',
      body: importDocsSchema,
      handler: ({ params, body }) => {
        requireWorkspaceExists(params.id);
        requireRepo(body.repo);
        return created({ docs: plan.docs.importFromRepo(params.id, body.repo, body.paths) });
      },
    }),

    // Synchronous like skill drafts: the modal waits while the agent writes.
    route({
      method: 'POST',
      path: '/api/workspaces/:id/docs/generate',
      access: 'docs:manage',
      body: generateDocSchema,
      handler: async ({ params, body }) => {
        requireWorkspaceExists(params.id);
        if (body.repo) requireRepo(body.repo);
        try {
          return created({ doc: await plan.docs.generate(params.id, body) });
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
});
