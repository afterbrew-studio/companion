import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { hasPermission, type AuthUser } from '@companion/contract';
import { savePipelineSchema, saveStepDefinitionSchema } from '../../pipelines/pipelines.js';
import { route, created, notFound, badRequest, forbidden, type CompiledRoute } from '../router.js';
import { rowToRepo } from '../../store/db.js';
import type { ApiDeps } from '../deps.js';

const workspaceSchema = z.object({
  name: z.string().min(2).max(80),
  description: z.string().max(500).default(''),
  visibility: z.enum(['public', 'private']).optional(),
});
const workspacePatchSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  description: z.string().max(500).optional(),
  visibility: z.enum(['public', 'private']).optional(),
});
const memberSchema = z.object({ username: z.string().min(1).max(100) });

/** Workspace lifecycle + the per-workspace area feeds. */
export function workspaceRoutes(deps: ApiDeps): CompiledRoute[] {
  // Access gate: a private workspace the user isn't in reads as "not found" —
  // membership is hidden, so its existence is too.
  const requireWorkspace = (user: AuthUser | null, id: string) => {
    const ws = deps.store.workspaces.get(id);
    if (!ws || !user || !deps.store.workspaces.canAccess(user, ws)) {
      throw notFound(`workspace ${id} not found`);
    }
    return ws;
  };
  // Manage gate (rename/delete/members): owner or admin only.
  const requireManage = (user: AuthUser | null, id: string) => {
    const ws = requireWorkspace(user, id);
    if (!user || !deps.store.workspaces.canManage(user, ws)) {
      throw forbidden('only the workspace owner or an admin can manage this workspace');
    }
    return ws;
  };

  return [
    route({
      method: 'GET',
      path: '/api/workspaces',
      access: 'workspaces:read',
      handler: ({ user }) => ({ workspaces: deps.store.workspaces.listFor(user!) }),
    }),

    route({
      method: 'POST',
      path: '/api/workspaces',
      access: 'workspaces:create',
      body: workspaceSchema,
      handler: ({ body, user }) => {
        // Omitted visibility defaults to private (the per-user case); making a
        // workspace public — shared with everyone — needs workspaces:manage.
        const visibility = body.visibility ?? 'private';
        if (visibility === 'public' && !hasPermission(user!.role, 'workspaces:manage')) {
          throw forbidden('only an admin can create a public workspace');
        }
        const id = `ws-${randomUUID().slice(0, 12)}`;
        const taken = new Set(deps.store.workspaces.list().map((w) => w.slug));
        let slug = slugify(body.name, id);
        if (taken.has(slug)) slug = `${slug}-${id.slice(3, 7)}`;
        deps.store.workspaces.insert({
          id,
          name: body.name,
          slug,
          description: body.description,
          visibility,
          ownerId: visibility === 'private' ? user!.username : null,
        });
        deps.broadcast({ t: 'workspaces.changed' });
        return created({ workspace: deps.store.workspaces.get(id) });
      },
    }),

    route({
      method: 'PATCH',
      path: '/api/workspaces/:id',
      access: 'workspaces:read',
      body: workspacePatchSchema,
      handler: ({ params, body, user }) => {
        requireManage(user, params.id);
        if (body.visibility) deps.store.workspaces.setVisibility(params.id, body.visibility, user!.username);
        deps.store.workspaces.update(params.id, body);
        deps.broadcast({ t: 'workspaces.changed' });
        return { workspace: deps.store.workspaces.get(params.id) };
      },
    }),

    route({
      method: 'DELETE',
      path: '/api/workspaces/:id',
      access: 'workspaces:read',
      handler: ({ params, user }) => {
        const ws = requireManage(user, params.id);
        if (ws.repoCount > 0) {
          throw badRequest('workspace still has repos — move or remove them first');
        }
        if (deps.store.workspaces.list().length === 1) {
          throw badRequest('cannot delete the last workspace');
        }
        deps.store.workspaces.delete(params.id);
        deps.broadcast({ t: 'workspaces.changed' });
        return { ok: true };
      },
    }),

    // ---------- private-workspace membership -----------------------------------

    route({
      method: 'GET',
      path: '/api/workspaces/:id/members',
      access: 'workspaces:read',
      handler: ({ params, user }) => {
        requireWorkspace(user, params.id);
        return { members: deps.store.workspaces.members(params.id) };
      },
    }),

    // Typeahead for the member picker: users who could be invited (not already
    // members, not disabled). Manager-gated, and returns only name + handle —
    // never roles/emails — so a non-admin owner can search without users:manage.
    route({
      method: 'GET',
      path: '/api/workspaces/:id/member-candidates',
      access: 'workspaces:read',
      handler: ({ params, query, user }) => {
        requireManage(user, params.id);
        const members = new Set(deps.store.workspaces.members(params.id).map((m) => m.username));
        const { users } = deps.store.users.search({ q: query.get('q') ?? undefined, limit: 24 });
        const candidates = users
          .filter((u) => !u.disabled && !members.has(u.username))
          .slice(0, 8)
          .map((u) => ({ username: u.username, displayName: u.displayName }));
        return { candidates };
      },
    }),

    route({
      method: 'POST',
      path: '/api/workspaces/:id/members',
      access: 'workspaces:read',
      body: memberSchema,
      handler: ({ params, body, user }) => {
        const ws = requireManage(user, params.id);
        if (ws.visibility !== 'private') throw badRequest('only private workspaces have members');
        if (!deps.store.users.get(body.username)) throw notFound(`user ${body.username} not found`);
        deps.store.workspaces.addMember(params.id, body.username, 'member');
        deps.broadcast({ t: 'workspaces.changed' });
        return created({ members: deps.store.workspaces.members(params.id) });
      },
    }),

    route({
      method: 'DELETE',
      path: '/api/workspaces/:id/members/:username',
      access: 'workspaces:read',
      handler: ({ params, user }) => {
        requireManage(user, params.id);
        if (params.username === user!.username && user!.role !== 'admin') {
          throw badRequest('the owner cannot remove themselves — delete the workspace instead');
        }
        deps.store.workspaces.removeMember(params.id, params.username);
        deps.broadcast({ t: 'workspaces.changed' });
        return { members: deps.store.workspaces.members(params.id) };
      },
    }),

    // ---------- area feeds -----------------------------------------------------

    route({
      method: 'GET',
      path: '/api/workspaces/:id/repos',
      access: 'repos:read',
      handler: ({ params, user }) => {
        requireWorkspace(user, params.id);
        return {
          repos: deps.store.repos.listByWorkspace(params.id).map((row) => ({
            ...rowToRepo(row),
            openIssues: deps.store.issues.list(row.full_name, 'open').length,
          })),
        };
      },
    }),

    route({
      method: 'GET',
      path: '/api/workspaces/:id/issues',
      access: 'issues:read',
      handler: ({ params, query, user }) => {
        requireWorkspace(user, params.id);
        const state = query.get('state');
        return deps.store.issues.listWorkspacePaged(
          params.id,
          state === 'open' || state === 'closed' ? state : undefined,
          {
            q: query.get('q') ?? undefined,
            repo: query.get('repo') ?? undefined,
            author: query.get('author') ?? undefined,
            assignee: query.get('assignee') ?? undefined,
            label: query.get('label') ?? undefined,
            triage: pick(query.get('triage'), ['pending', 'applied', 'dismissed'] as const),
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
      handler: ({ params, query, user }) => {
        requireWorkspace(user, params.id);
        const state = query.get('state');
        const page = deps.store.prs.listWorkspacePaged(
          params.id,
          state === 'open' || state === 'merged' || state === 'closed' ? state : undefined,
          {
            q: query.get('q') ?? undefined,
            repo: query.get('repo') ?? undefined,
            author: query.get('author') ?? undefined,
            assignee: query.get('assignee') ?? undefined,
            decision: pick(query.get('decision'), ['approved', 'changes_requested', 'none'] as const),
            review: pick(query.get('review'), ['pending', 'applied', 'dismissed'] as const),
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

    /** The review inbox: everything awaiting a human decision in this workspace. */
    route({
      method: 'GET',
      path: '/api/workspaces/:id/reviews',
      access: 'runs:read',
      handler: ({ params, user }) => {
        requireWorkspace(user, params.id);
        const repoNames = new Set(deps.store.repos.listByWorkspace(params.id).map((r) => r.full_name));
        const runs = deps.orchestrator
          .listRuns()
          .filter((r) => r.status === 'review' && r.repo !== null && repoNames.has(r.repo));
        const prReviews = deps.store.prReviews.listWorkspacePending(params.id).map((review) => ({
          review,
          title: deps.store.prs.get(review.repo, review.prNumber)?.title ?? `PR #${review.prNumber}`,
        }));
        const triage = deps.store.triage.listWorkspacePending(params.id).map((t) => ({
          triage: t,
          title: deps.store.issues.get(t.repo, t.issueNumber)?.title ?? `Issue #${t.issueNumber}`,
        }));
        return { runs, prReviews, triage };
      },
    }),

    route({
      method: 'GET',
      path: '/api/workspaces/:id/metrics',
      access: 'issues:read',
      handler: ({ params, user }) => {
        requireWorkspace(user, params.id);
        return { metrics: deps.store.workspaces.metrics(params.id) };
      },
    }),

    route({
      method: 'GET',
      path: '/api/workspaces/:id/proposals',
      access: 'proposals:read',
      handler: ({ params, user }) => {
        requireWorkspace(user, params.id);
        return { proposals: deps.store.proposals.listWorkspace(params.id) };
      },
    }),

    // ---------- workspace briefing ----------------------------------------------

    route({
      method: 'GET',
      path: '/api/workspaces/:id/briefing',
      access: 'automations:manage',
      handler: ({ params, user }) => {
        requireWorkspace(user, params.id);
        return { cadence: deps.automations.briefingCadence(params.id) };
      },
    }),

    route({
      method: 'PUT',
      path: '/api/workspaces/:id/briefing',
      access: 'automations:manage',
      body: z.object({ cadence: z.enum(['off', 'daily', 'weekly']) }),
      handler: ({ params, body, user }) => {
        requireWorkspace(user, params.id);
        deps.automations.setBriefingCadence(params.id, body.cadence);
        return { cadence: body.cadence };
      },
    }),

    route({
      method: 'POST',
      path: '/api/workspaces/:id/briefing-now',
      access: 'automations:manage',
      handler: async ({ params, user }) => {
        requireWorkspace(user, params.id);
        await deps.automations.runBriefing(params.id);
        return { ok: true };
      },
    }),

    // ---------- pipelines + step library (workspace-scoped) ----------------------

    route({
      method: 'GET',
      path: '/api/workspaces/:id/pipelines',
      access: 'pipelines:read',
      handler: ({ params, user }) => {
        requireWorkspace(user, params.id);
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
      handler: ({ params, body, user }) => {
        requireWorkspace(user, params.id);
        return created({ pipeline: deps.pipelines.create(params.id, body) });
      },
    }),

    route({
      method: 'POST',
      path: '/api/workspaces/:id/step-definitions',
      access: 'pipelines:manage',
      body: saveStepDefinitionSchema,
      handler: ({ params, body, user }) => {
        requireWorkspace(user, params.id);
        return created({ stepDefinition: deps.pipelines.createStepDefinition(params.id, body) });
      },
    }),

    route({
      method: 'GET',
      path: '/api/workspaces/:id/pipeline-runs',
      access: 'pipelines:read',
      handler: ({ params, user }) => {
        requireWorkspace(user, params.id);
        return { runs: deps.store.pipelines.listWorkspaceRuns(params.id) };
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
