import { z } from 'zod';
import type { AuthUser, CommentRecord } from '@companion/contract';
import { route, accepted, created, notFound, badRequest, type CompiledRoute } from '../router.js';
import { log } from '../../log.js';
import type { ApiDeps } from '../deps.js';

const applyTriageSchema = z.object({ comment: z.boolean().default(true) });
const commentSchema = z.object({ body: z.string().min(1).max(64_000) });
const stateSchema = z.object({ state: z.enum(['open', 'closed']) });

export function issueRoutes(deps: ApiDeps): CompiledRoute[] {
  const requireIssue = (user: AuthUser | null, owner: string, name: string, number: string) => {
    const fullName = `${owner}/${name}`;
    const issue = deps.store.issues.get(fullName, Number(number));
    if (!issue || !user || !deps.store.workspaces.canAccessRepo(user, fullName)) {
      throw notFound(`issue ${fullName}#${number} not found`);
    }
    return { fullName, issue };
  };

  return [
    route({
      method: 'GET',
      path: '/api/repos/:owner/:name/issues/:number',
      access: 'issues:read',
      handler: ({ params, user }) => {
        const { fullName, issue } = requireIssue(user, params.owner, params.name, params.number);
        return { issue, triage: deps.store.triage.latest(fullName, issue.number) ?? null };
      },
    }),

    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/issues/:number/triage',
      access: 'issues:act',
      handler: ({ params, user }) => {
        const { fullName, issue } = requireIssue(user, params.owner, params.name, params.number);
        // Long-running; kick it and let the UI follow triage.changed.
        void deps.triage
          .triageIssue(fullName, issue.number)
          .catch((err) => log.warn('triage failed', { fullName, number: issue.number, err: String(err) }));
        return accepted({ queued: true });
      },
    }),

    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/issues/:number/fix',
      access: 'issues:act',
      handler: async ({ params, user }) => {
        const { fullName, issue } = requireIssue(user, params.owner, params.name, params.number);
        const run = await deps.fixes.startFix(fullName, issue.number);
        return created({ run });
      },
    }),

    /** Live conversation from GitHub (read-through, newest last). */
    route({
      method: 'GET',
      path: '/api/repos/:owner/:name/issues/:number/comments',
      access: 'issues:read',
      handler: async ({ params, user }) => {
        const { fullName, issue } = requireIssue(user, params.owner, params.name, params.number);
        const client = deps.github();
        if (!client) throw badRequest('GitHub is not configured');
        const raw = await client.issueComments(fullName, issue.number);
        const comments: CommentRecord[] = raw.map((c) => ({
          author: c.user?.login ?? 'unknown',
          body: c.body,
          createdAt: Date.parse(c.created_at),
        }));
        return { comments };
      },
    }),

    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/issues/:number/comment',
      access: 'issues:act',
      body: commentSchema,
      handler: async ({ params, body, user }) => {
        const { fullName, issue } = requireIssue(user, params.owner, params.name, params.number);
        const client = deps.github();
        if (!client) throw badRequest('GitHub is not configured');
        const result = await client.comment(fullName, issue.number, body.body);
        return { url: result.html_url };
      },
    }),

    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/issues/:number/state',
      access: 'issues:act',
      body: stateSchema,
      handler: async ({ params, body, user }) => {
        const { fullName, issue } = requireIssue(user, params.owner, params.name, params.number);
        const client = deps.github();
        if (!client) throw badRequest('GitHub is not configured');
        await client.updateIssueState(fullName, issue.number, body.state);
        void deps.sync.syncRepo(fullName).catch(() => undefined);
        deps.broadcast({ t: 'issues.changed', repo: fullName });
        return { ok: true };
      },
    }),

    /** Kick an issue-type pipeline against this issue. */
    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/issues/:number/pipelines/:pipelineId/run',
      access: 'pipelines:run',
      handler: ({ params, user }) => {
        const { fullName, issue } = requireIssue(user, params.owner, params.name, params.number);
        const pipeline = deps.store.pipelines.get(params.pipelineId);
        if (pipeline && pipeline.type !== 'issue') throw badRequest(`"${pipeline.name}" is a ${pipeline.type} pipeline`);
        const run = deps.pipelines.start(params.pipelineId, fullName, issue.number, 'manual');
        return created({ run });
      },
    }),

    route({
      method: 'GET',
      path: '/api/repos/:owner/:name/issues/:number/pipeline-runs',
      access: 'issues:read',
      handler: ({ params, user }) => {
        const { fullName } = requireIssue(user, params.owner, params.name, params.number);
        return { runs: deps.store.pipelines.listRunsForIssue(fullName, Number(params.number)) };
      },
    }),

    route({
      method: 'POST',
      path: '/api/triage/:id/apply',
      access: 'issues:act',
      body: applyTriageSchema,
      handler: async ({ params, query, body }) => {
        await deps.triage.apply(params.id, { comment: body.comment, accountId: query.get('account') ?? undefined });
        return { ok: true };
      },
    }),

    route({
      method: 'POST',
      path: '/api/triage/:id/dismiss',
      access: 'issues:act',
      handler: ({ params }) => {
        deps.triage.dismiss(params.id);
        return { ok: true };
      },
    }),
  ];
}
