import { z } from 'zod';
import type { CommentRecord } from '@companion/contract';
import { route, accepted, created, notFound, badRequest, type CompiledRoute } from '../router.js';
import { log } from '../../log.js';
import type { ApiDeps } from '../deps.js';

const mergeSchema = z.object({ method: z.enum(['merge', 'squash', 'rebase']).default('squash') });
const commentSchema = z.object({ body: z.string().min(1).max(64_000) });

export function prRoutes(deps: ApiDeps): CompiledRoute[] {
  const requirePr = (owner: string, name: string, number: string) => {
    const fullName = `${owner}/${name}`;
    const pr = deps.store.prs.get(fullName, Number(number));
    if (!pr) throw notFound(`PR ${fullName}#${number} not found`);
    return { fullName, pr };
  };

  return [
    route({
      method: 'GET',
      path: '/api/repos/:owner/:name/prs/:number',
      access: 'prs:read',
      handler: ({ params }) => {
        const { fullName, pr } = requirePr(params.owner, params.name, params.number);
        return {
          pr,
          review: deps.store.prReviews.latest(fullName, pr.number) ?? null,
          pipelineRuns: deps.store.pipelines.listRunsForPr(fullName, pr.number),
          ciAnalysis: deps.store.reports.latestFor(fullName, pr.number, 'ci-analysis'),
        };
      },
    }),

    /** PR conversation (GitHub's issues API serves PR numbers too). */
    route({
      method: 'GET',
      path: '/api/repos/:owner/:name/prs/:number/comments',
      access: 'prs:read',
      handler: async ({ params }) => {
        const { fullName, pr } = requirePr(params.owner, params.name, params.number);
        const client = deps.github();
        if (!client) throw badRequest('GitHub is not configured');
        const raw = await client.issueComments(fullName, pr.number);
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
      path: '/api/repos/:owner/:name/prs/:number/comment',
      access: 'prs:act',
      body: commentSchema,
      handler: async ({ params, body }) => {
        const { fullName, pr } = requirePr(params.owner, params.name, params.number);
        const client = deps.github();
        if (!client) throw badRequest('GitHub is not configured');
        const result = await client.comment(fullName, pr.number, body.body);
        return { url: result.html_url };
      },
    }),

    /** Agent post-mortem of the PR's failing pipelines (async; report lands as ci-analysis). */
    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/prs/:number/checks/analyze',
      access: 'prs:act',
      handler: ({ params }) => {
        const { fullName, pr } = requirePr(params.owner, params.name, params.number);
        void deps.prReviews
          .analyzeFailedChecks(fullName, pr.number)
          .catch((err) => log.warn('CI analysis failed', { fullName, number: pr.number, err: String(err) }));
        return accepted({ queued: true });
      },
    }),

    /** Repair agent: works ON the PR branch until the failing checks pass. */
    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/prs/:number/fix-checks',
      access: 'prs:act',
      handler: async ({ params }) => {
        const { fullName, pr } = requirePr(params.owner, params.name, params.number);
        try {
          return { run: await deps.fixes.startCheckFix(fullName, pr.number) };
        } catch (err) {
          throw badRequest(String(err instanceof Error ? err.message : err));
        }
      },
    }),

    /** Resolution agent: implements what human reviewers asked for, on the PR branch. */
    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/prs/:number/address-reviews',
      access: 'prs:act',
      handler: async ({ params }) => {
        const { fullName, pr } = requirePr(params.owner, params.name, params.number);
        try {
          return { run: await deps.fixes.startReviewFix(fullName, pr.number) };
        } catch (err) {
          throw badRequest(String(err instanceof Error ? err.message : err));
        }
      },
    }),

    /** Fresh CI pipeline status straight from GitHub (also updates the snapshot). */
    route({
      method: 'GET',
      path: '/api/repos/:owner/:name/prs/:number/checks',
      access: 'prs:read',
      handler: async ({ params }) => {
        const { fullName, pr } = requirePr(params.owner, params.name, params.number);
        return { checks: await deps.prChecks.fetchSummary(fullName, pr.number) };
      },
    }),

    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/prs/:number/analyze',
      access: 'prs:act',
      handler: ({ params }) => {
        const { fullName, pr } = requirePr(params.owner, params.name, params.number);
        void deps.prReviews
          .analyzePr(fullName, pr.number)
          .catch((err) => log.warn('pr analysis failed', { fullName, number: pr.number, err: String(err) }));
        return accepted({ queued: true });
      },
    }),

    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/prs/:number/merge',
      access: 'prs:act',
      body: mergeSchema,
      handler: async ({ params, body }) => {
        const { fullName, pr } = requirePr(params.owner, params.name, params.number);
        await deps.prReviews.merge(fullName, pr.number, body.method);
        return { ok: true };
      },
    }),

    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/prs/:number/close',
      access: 'prs:act',
      handler: async ({ params }) => {
        const { fullName, pr } = requirePr(params.owner, params.name, params.number);
        await deps.prReviews.close(fullName, pr.number);
        return { ok: true };
      },
    }),

    /** Kick a user-defined pipeline against this PR. */
    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/prs/:number/pipelines/:pipelineId/run',
      access: 'pipelines:run',
      handler: ({ params }) => {
        const { fullName, pr } = requirePr(params.owner, params.name, params.number);
        const pipeline = deps.store.pipelines.get(params.pipelineId);
        if (pipeline && pipeline.type !== 'pr') throw badRequest(`"${pipeline.name}" is a ${pipeline.type} pipeline`);
        const run = deps.pipelines.start(params.pipelineId, fullName, pr.number, 'manual');
        return created({ run });
      },
    }),

    route({
      method: 'GET',
      path: '/api/repos/:owner/:name/prs/:number/pipeline-runs',
      access: 'prs:read',
      handler: ({ params }) => {
        const { fullName, pr } = requirePr(params.owner, params.name, params.number);
        return { runs: deps.store.pipelines.listRunsForPr(fullName, pr.number) };
      },
    }),

    route({
      method: 'POST',
      path: '/api/pr-reviews/:id/apply',
      access: 'prs:act',
      handler: async ({ params, query }) => {
        await deps.prReviews.apply(params.id, query.get('account') ?? undefined);
        return { ok: true };
      },
    }),

    route({
      method: 'POST',
      path: '/api/pr-reviews/:id/dismiss',
      access: 'prs:act',
      handler: ({ params }) => {
        deps.prReviews.dismiss(params.id);
        return { ok: true };
      },
    }),
  ];
}
