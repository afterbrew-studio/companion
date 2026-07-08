import { z } from 'zod';
import type { AuthUser, RunRecord } from '@companion/contract';
import { route, created, notFound, type CompiledRoute } from '../router.js';
import type { ApiDeps } from '../deps.js';

const createRunSchema = z.object({
  kind: z.enum(['interactive', 'triage', 'fix', 'analysis', 'implement', 'report']).optional(),
  title: z.string().max(200).optional(),
});
const promptSchema = z.object({ prompt: z.string().min(1), model: z.string().optional() });
const askRespondSchema = z.object({
  requestId: z.string(),
  response: z.object({
    mode: z.enum(['allow', 'allow_session', 'allow_always', 'deny']).optional(),
    optionId: z.string().optional(),
    text: z.string().optional(),
  }),
});
const abortSchema = z.object({ turnId: z.string().optional() });
const approvePrSchema = z.object({ title: z.string().optional(), body: z.string().optional() });
const setModelSchema = z.object({
  model: z.string().min(1).max(256).nullable(),
  provider: z.string().min(1).max(64).optional(),
});

export function runRoutes(deps: ApiDeps): CompiledRoute[] {
  // Visibility:
  //  - Attended chats (interactive / AI Help) are PRIVATE to their owner
  //    (and admins) — one maintainer must not see another's AI Help.
  //  - Runs tied to a repo inherit that repo's workspace access.
  //  - Other repo-less runs (automated one-shots) stay visible to runs:read.
  const canSeeRun = (user: AuthUser | null, run: RunRecord): boolean => {
    if (!user) return false;
    if (user.role === 'admin') return true;
    if (run.kind === 'interactive' || run.kind === 'assistant') return run.userId === user.username;
    if (run.repo) return deps.store.workspaces.canAccessRepo(user, run.repo);
    return true;
  };
  const requireRunAccess = (user: AuthUser | null, id: string): RunRecord => {
    const run = deps.orchestrator.getRun(id);
    if (!run || !canSeeRun(user, run)) throw notFound(`run ${id} not found`);
    return run;
  };

  return [
    route({
      method: 'GET',
      path: '/api/runs',
      access: 'runs:read',
      handler: ({ user }) => ({ runs: deps.orchestrator.listRuns().filter((r) => canSeeRun(user, r)) }),
    }),

    route({
      method: 'POST',
      path: '/api/runs',
      access: 'runs:act',
      body: createRunSchema,
      handler: async ({ body, user }) =>
        created({ run: await deps.orchestrator.createRun({ ...body, userId: user?.username ?? null }) }),
    }),

    route({
      method: 'GET',
      path: '/api/runs/:id',
      access: 'runs:read',
      handler: ({ params, user }) => {
        const run = requireRunAccess(user, params.id);
        return { run, pendingAsks: deps.orchestrator.pendingAsksFor(params.id) };
      },
    }),

    route({
      method: 'GET',
      path: '/api/runs/:id/history',
      access: 'runs:read',
      handler: async ({ params, query, user }) => {
        requireRunAccess(user, params.id);
        const before = query.get('before');
        const limit = Number(query.get('limit') ?? '200');
        return deps.orchestrator.loadHistory(
          params.id,
          before === null ? null : Number(before),
          Math.min(Math.max(limit, 1), 500),
        );
      },
    }),

    route({
      method: 'GET',
      path: '/api/runs/:id/diff',
      access: 'runs:read',
      handler: ({ params, user }) => {
        requireRunAccess(user, params.id);
        return deps.fixes.diff(params.id);
      },
    }),

    /** Connected providers + models from the run's live gateway. */
    route({
      method: 'GET',
      path: '/api/runs/:id/models',
      access: 'runs:read',
      handler: ({ params, user }) => {
        requireRunAccess(user, params.id);
        return deps.orchestrator.modelCatalog(params.id);
      },
    }),

    /** On-the-fly model switch for this run. */
    route({
      method: 'POST',
      path: '/api/runs/:id/model',
      access: 'runs:act',
      body: setModelSchema,
      handler: async ({ params, body, user }) => {
        requireRunAccess(user, params.id);
        return { run: await deps.orchestrator.setRunModel(params.id, body.model, body.provider) };
      },
    }),

    route({
      method: 'POST',
      path: '/api/runs/:id/approve-pr',
      access: 'runs:act',
      body: approvePrSchema,
      handler: ({ params, body, user }) => {
        requireRunAccess(user, params.id);
        return deps.fixes.approve(params.id, body);
      },
    }),

    route({
      method: 'POST',
      path: '/api/runs/:id/discard',
      access: 'runs:act',
      handler: async ({ params, user }) => {
        requireRunAccess(user, params.id);
        await deps.fixes.discard(params.id);
        return { ok: true };
      },
    }),

    route({
      method: 'POST',
      path: '/api/runs/:id/prompt',
      access: 'runs:act',
      body: promptSchema,
      handler: ({ params, body, user }) => {
        requireRunAccess(user, params.id);
        return deps.orchestrator.sendPrompt(params.id, body.prompt, body.model);
      },
    }),

    route({
      method: 'POST',
      path: '/api/runs/:id/abort',
      access: 'runs:act',
      body: abortSchema,
      handler: async ({ params, body, user }) => {
        requireRunAccess(user, params.id);
        await deps.orchestrator.abortTurn(params.id, body.turnId);
        return { ok: true };
      },
    }),

    route({
      method: 'POST',
      path: '/api/runs/:id/ask',
      access: 'runs:act',
      body: askRespondSchema,
      handler: async ({ params, body, user }) => {
        requireRunAccess(user, params.id);
        await deps.orchestrator.respondAsk(params.id, body.requestId, body.response);
        return { ok: true };
      },
    }),

    route({
      method: 'POST',
      path: '/api/runs/:id/resume',
      access: 'runs:act',
      handler: async ({ params, user }) => {
        requireRunAccess(user, params.id);
        return { run: await deps.orchestrator.resumeRun(params.id) };
      },
    }),

    route({
      method: 'POST',
      path: '/api/runs/:id/stop',
      access: 'runs:act',
      handler: async ({ params, user }) => {
        requireRunAccess(user, params.id);
        await deps.orchestrator.stopRun(params.id);
        return { ok: true };
      },
    }),
  ];
}
