import { z } from 'zod';
import { defineRoutes, route, created, accepted, badRequest, forbidden, notFound } from '@moxxy/companion-sdk/server';
import type { AuthUser } from '@moxxy/companion-contracts';
import type { WorkspaceRecord } from '@companion/module-workspace/contract';
import { log } from '@moxxy/companion-sdk/server';
import '../contract/index.js';
import { ProposalsStore } from './proposals-store.js';
import { SpecsStore } from './specs-store.js';

// ---------- proposals ----------

const proposalSchema = z.object({
  workspaceId: z.string().min(1).max(100),
  repo: z.string().min(3).max(300),
  title: z.string().min(3).max(200),
  body: z.string().min(1).max(256_000),
});

const patchProposalSchema = z.object({
  title: z.string().min(3).max(200).optional(),
  body: z.string().min(1).max(256_000).optional(),
}).strict();

// ---------- specs ----------

const storageSchema = z.enum(['virtual', 'repo']).optional();

const createSpecSchema = z.object({
  workspaceId: z.string().min(1).max(100),
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
  workspaceId: z.string().min(1).max(100),
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

function pageInteger(raw: string | null, fallback: number, min: number, max: number, name: string): number {
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) throw badRequest(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw badRequest(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

function queryChoice<const T extends string>(raw: string | null, choices: readonly T[], name: string): T | undefined {
  if (raw === null || raw === '') return undefined;
  if (!choices.includes(raw as T)) throw badRequest(`invalid ${name}`);
  return raw as T;
}

function queryText(raw: string | null, max: number, name: string): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (value.length > max) throw badRequest(`${name} is too long`);
  return value;
}

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

  const requireProposal = (user: AuthUser | null, id: string) => {
    const proposal = proposalsStore.get(id);
    if (!proposal || !user || !workspace.canAccessWorkspace(user, proposal.workspaceId)) {
      throw notFound(`proposal ${id} not found`);
    }
    return proposal;
  };
  const requireSpec = (user: AuthUser | null, id: string) => {
    const spec = specsStore.get(id);
    if (!spec || !user || !workspace.canAccessWorkspace(user, spec.workspaceId)) throw notFound(`spec ${id} not found`);
    return spec;
  };
  const requireDoc = (user: AuthUser | null, id: string) => {
    const doc = plan.docs.get(id);
    if (!doc || !user || !workspace.canAccessWorkspace(user, doc.workspaceId)) {
      throw notFound(`doc ${id} not found`);
    }
    return doc;
  };
  const requireRepo = (user: AuthUser | null, workspaceId: string, fullName: string) => {
    if (!code.repos.inWorkspace(fullName, workspaceId) || !user || !workspace.canAccessWorkspace(user, workspaceId)) {
      throw notFound(`repo ${fullName} not connected`);
    }
  };

  // Access gate for the workspace proposals feed: a private workspace the user
  // isn't in reads as "not found" — same helper as module-workspace's routes.
  const requireWorkspace = (user: AuthUser | null, id: string): WorkspaceRecord =>
    workspace.requireAccessible(user, id);

  const requireAgentRun: (user: AuthUser | null) => asserts user is AuthUser = (user) => {
    if (!user || !ctx.rbac.allows(user, 'runs:read') || !ctx.rbac.allows(user, 'runs:act')) {
      throw forbidden('this action also requires runs:read and runs:act');
    }
  };

  const requirePrWrite: (user: AuthUser | null) => asserts user is AuthUser = (user) => {
    if (!user || !ctx.rbac.allows(user, 'prs:read') || !ctx.rbac.allows(user, 'prs:act')) {
      throw forbidden('publishing an implementation also requires prs:read and prs:act');
    }
  };
  return [
    // ---------- proposals ----------------------------------------------------------

    route({
      method: 'GET',
      path: '/api/proposals',
      access: 'proposals:read',
      handler: ({ user }) => ({
        proposals: proposalsStore.list().filter((proposal) => workspace.canAccessWorkspace(user!, proposal.workspaceId)),
      }),
    }),

    route({
      method: 'POST',
      path: '/api/proposals',
      access: 'proposals:create',
      body: proposalSchema,
      handler: ({ body, user }) => {
        requireRepo(user, body.workspaceId, body.repo);
        return created({ proposal: plan.proposals.create(body.workspaceId, body.repo, body.title, body.body) });
      },
    }),

    // Domain permission and compute permission remain independent: a governed
    // role may file proposals without being allowed to spend agent capacity.
    route({
      method: 'POST',
      path: '/api/proposals/:id/analyze',
      access: 'proposals:create',
      handler: ({ params, user }) => {
        requireProposal(user, params.id);
        requireAgentRun(user);
        try {
          plan.proposals.validateAnalyze(params.id);
        } catch (err) {
          throw badRequest(String(err instanceof Error ? err.message : err));
        }
        void plan.proposals
          .analyze(params.id, user!.username)
          .catch((err) => log.warn('analysis failed', { id: params.id, err: String(err) }));
        return accepted({ queued: true });
      },
    }),

    route({
      method: 'PATCH',
      path: '/api/proposals/:id',
      access: 'proposals:create',
      body: patchProposalSchema,
      handler: ({ params, body, user }) => {
        requireProposal(user, params.id);
        try {
          return { proposal: plan.proposals.update(params.id, body) };
        } catch (err) {
          throw badRequest(String(err instanceof Error ? err.message : err));
        }
      },
    }),

    route({
      method: 'POST',
      path: '/api/proposals/:id/accept-plan',
      access: 'proposals:act',
      handler: ({ params, user }) => {
        requireProposal(user, params.id);
        try {
          return { proposal: plan.proposals.acceptPlan(params.id) };
        } catch (err) {
          throw badRequest(String(err instanceof Error ? err.message : err));
        }
      },
    }),

    route({
      method: 'POST',
      path: '/api/proposals/:id/approve',
      access: 'proposals:act',
      handler: async ({ params, user }) => {
        requireProposal(user, params.id);
        requireAgentRun(user);
        return { proposal: await plan.proposals.approve(params.id, user!.username) };
      },
    }),

    route({
      method: 'POST',
      path: '/api/proposals/:id/finish',
      access: 'proposals:act',
      handler: async ({ params, user }) => {
        requireProposal(user, params.id);
        requireAgentRun(user);
        requirePrWrite(user);
        return { proposal: await plan.proposals.finishImplementation(params.id, user!.username) };
      },
    }),

    route({
      method: 'POST',
      path: '/api/proposals/:id/reject',
      access: 'proposals:act',
      handler: ({ params, user }) => {
        requireProposal(user, params.id);
        plan.proposals.reject(params.id);
        return { ok: true };
      },
    }),

    // The workspace area feed (plan-owned cross-domain read).
    route({
      method: 'GET',
      path: '/api/workspaces/:id/proposals',
      access: 'proposals:read',
      handler: ({ params, query, user }) => {
        requireWorkspace(user, params.id);
        return plan.proposals.listPage(params.id, {
          q: queryText(query.get('q'), 200, 'q'),
          repo: queryText(query.get('repo'), 300, 'repo'),
          status: queryChoice(query.get('status'), [
            'draft', 'analyzing', 'analyzed', 'approved', 'implementing',
            'review', 'implemented', 'rejected', 'failed',
          ] as const, 'status'),
          limit: pageInteger(query.get('limit'), 50, 1, 100, 'limit'),
          offset: pageInteger(query.get('offset'), 0, 0, 1_000_000, 'offset'),
        });
      },
    }),

    route({
      method: 'GET',
      path: '/api/proposals/:id',
      access: 'proposals:read',
      handler: ({ params, user }) => ({ proposal: requireProposal(user, params.id) }),
    }),

    // ---------- specs ---------------------------------------------------------------

    route({
      method: 'GET',
      path: '/api/workspaces/:id/specs',
      access: 'specs:read',
      handler: ({ params, query, user }) => {
        requireWorkspace(user, params.id);
        return plan.specs.listPage(params.id, {
          q: queryText(query.get('q'), 200, 'q'),
          repo: queryText(query.get('repo'), 300, 'repo'),
          status: queryChoice(query.get('status'), ['generating', 'ready', 'failed', 'drifted'] as const, 'status'),
          source: queryChoice(query.get('source'), ['manual', 'generated', 'imported'] as const, 'source'),
          storage: queryChoice(query.get('storage'), ['virtual', 'repo'] as const, 'storage'),
          limit: pageInteger(query.get('limit'), 50, 1, 100, 'limit'),
          offset: pageInteger(query.get('offset'), 0, 0, 1_000_000, 'offset'),
        });
      },
    }),

    route({
      method: 'GET',
      path: '/api/specs/:id',
      access: 'specs:read',
      handler: ({ params, user }) => ({ spec: requireSpec(user, params.id) }),
    }),

    // ---------- storage configuration (first-visit setup) ---------------------

    route({
      method: 'GET',
      path: '/api/workspaces/:id/specs-config',
      access: 'specs:read',
      handler: ({ params, user }) => {
        requireWorkspace(user, params.id);
        return plan.specs.storageState(params.id);
      },
    }),

    route({
      method: 'PUT',
      path: '/api/workspaces/:id/specs-config',
      access: 'specs:manage',
      body: specConfigSchema,
      handler: ({ params, body, user }) => {
        requireWorkspace(user, params.id);
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
      handler: ({ body, user }) => {
        requireRepo(user, body.workspaceId, body.repo);
        try {
          return created({ spec: plan.specs.create(body.workspaceId, body.repo, body.title, body.content, body.storage) });
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
      handler: ({ params, body, user }) => {
        requireSpec(user, params.id);
        return { spec: plan.specs.update(params.id, body) };
      },
    }),

    route({
      method: 'DELETE',
      path: '/api/specs/:id',
      access: 'specs:manage',
      handler: ({ params, user }) => {
        requireSpec(user, params.id);
        plan.specs.remove(params.id);
        return { ok: true };
      },
    }),

    route({
      method: 'POST',
      path: '/api/specs/generate',
      access: 'specs:manage',
      body: generateSpecSchema,
      handler: ({ body, user }) => {
        requireRepo(user, body.workspaceId, body.repo);
        requireAgentRun(user);
        void plan.specs
          .generate(body.workspaceId, body.repo, body.instructions, body.storage, user!.username)
          .catch((err) => log.warn('spec generation failed', { repo: body.repo, err: String(err) }));
        return accepted({ queued: true });
      },
    }),

    route({
      method: 'POST',
      path: '/api/specs/:id/dismiss-drift',
      access: 'specs:manage',
      handler: ({ params, user }) => {
        requireSpec(user, params.id);
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
      handler: ({ params, user }) => {
        const proposal = requireProposal(user, params.id);
        requireAgentRun(user);
        if (proposal.status !== 'implemented') throw badRequest(`proposal is ${proposal.status}, not implemented`);
        void plan.specs
          .generate(
            proposal.workspaceId,
            proposal.repo,
            `Document, as a specification of the CURRENT behavior, the feature implemented by the proposal "${proposal.title}". Original proposal:\n${proposal.body.slice(0, 2000)}`,
            undefined,
            user!.username,
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
      handler: ({ params, body, user }) => {
        requireSpec(user, params.id);
        return created({ proposal: plan.specs.createFeature(params.id, body, user!.username) });
      },
    }),

    // ---------- docs ----------------------------------------------------------------

    route({
      method: 'GET',
      path: '/api/workspaces/:id/docs',
      access: 'docs:read',
      handler: ({ params, query, user }) => {
        requireWorkspace(user, params.id);
        const repo = queryText(query.get('repo'), 300, 'repo');
        return plan.docs.listPage(params.id, {
          q: queryText(query.get('q'), 200, 'q'),
          repo: repo === '__workspace' ? null : repo,
          source: queryChoice(query.get('source'), ['manual', 'generated', 'imported'] as const, 'source'),
          storage: queryChoice(query.get('storage'), ['virtual', 'repo'] as const, 'storage'),
          limit: pageInteger(query.get('limit'), 50, 1, 100, 'limit'),
          offset: pageInteger(query.get('offset'), 0, 0, 1_000_000, 'offset'),
        });
      },
    }),

    route({
      method: 'GET',
      path: '/api/workspaces/:id/docs/search',
      access: 'docs:read',
      handler: ({ params, query, user }) => {
        requireWorkspace(user, params.id);
        const q = query.get('q') ?? '';
        const limit = Math.min(Number(query.get('limit')) || 8, 25);
        return { hits: plan.docs.search(params.id, q, limit) };
      },
    }),

    route({
      method: 'GET',
      path: '/api/docs/:id',
      access: 'docs:read',
      handler: ({ params, user }) => ({ doc: requireDoc(user, params.id) }),
    }),

    // ---------- storage configuration (first-visit setup) ---------------------

    route({
      method: 'GET',
      path: '/api/workspaces/:id/docs-config',
      access: 'docs:read',
      handler: ({ params, user }) => {
        requireWorkspace(user, params.id);
        return plan.docs.storageState(params.id);
      },
    }),

    route({
      method: 'PUT',
      path: '/api/workspaces/:id/docs-config',
      access: 'docs:manage',
      body: docConfigSchema,
      handler: ({ params, body, user }) => {
        requireWorkspace(user, params.id);
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
      handler: ({ params, body, user }) => {
        requireWorkspace(user, params.id);
        if (body.repo) requireRepo(user, params.id, body.repo);
        return created({ doc: plan.docs.create(params.id, { ...body, repo: body.repo ?? null }) });
      },
    }),

    route({
      method: 'PATCH',
      path: '/api/docs/:id',
      access: 'docs:manage',
      body: patchDocSchema,
      handler: ({ params, body, user }) => {
        const doc = requireDoc(user, params.id);
        if (body.repo) requireRepo(user, doc.workspaceId, body.repo);
        return { doc: plan.docs.update(params.id, body) };
      },
    }),

    route({
      method: 'DELETE',
      path: '/api/docs/:id',
      access: 'docs:manage',
      handler: ({ params, user }) => {
        requireDoc(user, params.id);
        plan.docs.remove(params.id);
        return { ok: true };
      },
    }),

    route({
      method: 'GET',
      path: '/api/repos/:owner/:name/doc-files',
      access: 'docs:read',
      handler: ({ params, user }) => {
        const fullName = `${params.owner}/${params.name}`;
        if (!user || !workspace.canAccessRepo(user, fullName)) throw notFound(`repo ${fullName} not connected`);
        return { files: plan.docs.importCandidates(fullName) };
      },
    }),

    route({
      method: 'POST',
      path: '/api/workspaces/:id/docs/import',
      access: 'docs:manage',
      body: importDocsSchema,
      handler: ({ params, body, user }) => {
        requireWorkspace(user, params.id);
        requireRepo(user, params.id, body.repo);
        return created({ docs: plan.docs.importFromRepo(params.id, body.repo, body.paths) });
      },
    }),

    // Synchronous like skill drafts: the modal waits while the agent writes.
    route({
      method: 'POST',
      path: '/api/workspaces/:id/docs/generate',
      access: 'docs:manage',
      body: generateDocSchema,
      handler: async ({ params, body, user }) => {
        requireWorkspace(user, params.id);
        if (body.repo) requireRepo(user, params.id, body.repo);
        requireAgentRun(user);
        try {
          return created({ doc: await plan.docs.generate(params.id, body, user!.username) });
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
