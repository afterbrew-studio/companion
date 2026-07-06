import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { savePipelineSchema, saveStepDefinitionSchema } from '../../pipelines/pipelines.js';
import { route, created, notFound, badRequest, type CompiledRoute } from '../router.js';
import { rowToRepo } from '../../store/db.js';
import type { ApiDeps } from '../deps.js';

const workspaceSchema = z.object({
  name: z.string().min(2).max(80),
  description: z.string().max(500).default(''),
});
const workspacePatchSchema = workspaceSchema.partial();

/** Workspace lifecycle + the per-workspace area feeds. */
export function workspaceRoutes(deps: ApiDeps): CompiledRoute[] {
  const requireWorkspace = (id: string) => {
    const ws = deps.store.getWorkspace(id);
    if (!ws) throw notFound(`workspace ${id} not found`);
    return ws;
  };

  return [
    route({
      method: 'GET',
      path: '/api/workspaces',
      access: 'workspaces:read',
      handler: () => ({ workspaces: deps.store.listWorkspaces() }),
    }),

    route({
      method: 'POST',
      path: '/api/workspaces',
      access: 'workspaces:manage',
      body: workspaceSchema,
      handler: ({ body }) => {
        const id = `ws-${randomUUID().slice(0, 12)}`;
        const taken = new Set(deps.store.listWorkspaces().map((w) => w.slug));
        let slug = slugify(body.name, id);
        if (taken.has(slug)) slug = `${slug}-${id.slice(3, 7)}`;
        deps.store.insertWorkspace({ id, name: body.name, slug, description: body.description });
        deps.broadcast({ t: 'workspaces.changed' });
        return created({ workspace: deps.store.getWorkspace(id) });
      },
    }),

    route({
      method: 'PATCH',
      path: '/api/workspaces/:id',
      access: 'workspaces:manage',
      body: workspacePatchSchema,
      handler: ({ params, body }) => {
        requireWorkspace(params.id);
        deps.store.updateWorkspace(params.id, body);
        deps.broadcast({ t: 'workspaces.changed' });
        return { workspace: deps.store.getWorkspace(params.id) };
      },
    }),

    route({
      method: 'DELETE',
      path: '/api/workspaces/:id',
      access: 'workspaces:manage',
      handler: ({ params }) => {
        const ws = requireWorkspace(params.id);
        if (ws.repoCount > 0) {
          throw badRequest('workspace still has repos — move or remove them first');
        }
        if (deps.store.listWorkspaces().length === 1) {
          throw badRequest('cannot delete the last workspace');
        }
        deps.store.deleteWorkspace(params.id);
        deps.broadcast({ t: 'workspaces.changed' });
        return { ok: true };
      },
    }),

    // ---------- area feeds -----------------------------------------------------

    route({
      method: 'GET',
      path: '/api/workspaces/:id/repos',
      access: 'repos:read',
      handler: ({ params }) => {
        requireWorkspace(params.id);
        return {
          repos: deps.store.listReposByWorkspace(params.id).map((row) => ({
            ...rowToRepo(row),
            openIssues: deps.store.listIssues(row.full_name, 'open').length,
          })),
        };
      },
    }),

    route({
      method: 'GET',
      path: '/api/workspaces/:id/issues',
      access: 'issues:read',
      handler: ({ params, query }) => {
        requireWorkspace(params.id);
        const state = query.get('state');
        return deps.store.listWorkspaceIssuesPaged(
          params.id,
          state === 'open' || state === 'closed' ? state : undefined,
          {
            q: query.get('q') ?? undefined,
            repo: query.get('repo') ?? undefined,
            author: query.get('author') ?? undefined,
            assignee: query.get('assignee') ?? undefined,
            label: query.get('label') ?? undefined,
            limit: Number(query.get('limit')) || undefined,
            offset: Number(query.get('offset')) || undefined,
          },
        );
      },
    }),

    route({
      method: 'GET',
      path: '/api/workspaces/:id/prs',
      access: 'prs:read',
      handler: ({ params, query }) => {
        requireWorkspace(params.id);
        const state = query.get('state');
        const page = deps.store.listWorkspacePrsPaged(
          params.id,
          state === 'open' || state === 'merged' || state === 'closed' ? state : undefined,
          {
            q: query.get('q') ?? undefined,
            repo: query.get('repo') ?? undefined,
            author: query.get('author') ?? undefined,
            assignee: query.get('assignee') ?? undefined,
            decision: pick(query.get('decision'), ['approved', 'changes_requested', 'none'] as const),
            draft: pick(query.get('draft'), ['hide', 'only'] as const),
            limit: Number(query.get('limit')) || undefined,
            offset: Number(query.get('offset')) || undefined,
          },
        );
        // Warm missing/stale check snapshots for exactly the page being viewed;
        // each landing snapshot broadcasts prs.changed so the list fills in live.
        deps.prChecks.preloadWorkspace(params.id, page.prs);
        return page;
      },
    }),

    route({
      method: 'GET',
      path: '/api/workspaces/:id/metrics',
      access: 'issues:read',
      handler: ({ params }) => {
        requireWorkspace(params.id);
        return { metrics: deps.store.workspaceMetrics(params.id) };
      },
    }),

    route({
      method: 'GET',
      path: '/api/workspaces/:id/proposals',
      access: 'proposals:read',
      handler: ({ params }) => {
        requireWorkspace(params.id);
        return { proposals: deps.store.listWorkspaceProposals(params.id) };
      },
    }),

    // ---------- pipelines + step library (workspace-scoped) ----------------------

    route({
      method: 'GET',
      path: '/api/workspaces/:id/pipelines',
      access: 'pipelines:read',
      handler: ({ params }) => {
        requireWorkspace(params.id);
        return {
          pipelines: deps.pipelines.list(params.id),
          stepDefinitions: deps.pipelines.listStepDefinitions(params.id),
        };
      },
    }),

    route({
      method: 'POST',
      path: '/api/workspaces/:id/pipelines',
      access: 'pipelines:manage',
      body: savePipelineSchema,
      handler: ({ params, body }) => {
        requireWorkspace(params.id);
        return created({ pipeline: deps.pipelines.create(params.id, body) });
      },
    }),

    route({
      method: 'POST',
      path: '/api/workspaces/:id/step-definitions',
      access: 'pipelines:manage',
      body: saveStepDefinitionSchema,
      handler: ({ params, body }) => {
        requireWorkspace(params.id);
        return created({ stepDefinition: deps.pipelines.createStepDefinition(params.id, body) });
      },
    }),

    route({
      method: 'GET',
      path: '/api/workspaces/:id/pipeline-runs',
      access: 'pipelines:read',
      handler: ({ params }) => {
        requireWorkspace(params.id);
        return { runs: deps.store.listWorkspacePipelineRuns(params.id) };
      },
    }),
  ];
}

function pick<T extends string>(value: string | null, allowed: readonly T[]): T | undefined {
  return allowed.includes(value as T) ? (value as T) : undefined;
}

function slugify(name: string, fallback: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || fallback;
}
