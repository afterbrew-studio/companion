import { z } from 'zod';
import type { AuthUser } from '@moxxy-ai/companion-sdk';
import { HttpError, badRequest, created, defineRoutes, notFound, route } from '@moxxy-ai/companion-sdk/server';
import { PLANNER_DISCUSSION_CONTEXTS } from '../contract/index.js';
import { artifactBundleSchema, featureBriefSchema } from './prompts.js';
import { PlannerQuestionSetConflict, PlannerRevisionConflict } from './planner-store.js';

const revisionSchema = z.object({ expectedRevision: z.number().int().min(0) }).strict();
const launchSchema = revisionSchema.extend({
  targetBranch: z.string().trim().min(1).max(300).optional(),
}).strict();
const createSchema = z.object({
  workspaceId: z.string().min(1).max(100),
  repo: z.string().min(1).max(300),
  idea: z.string().trim().min(1).max(8_000),
  title: z.string().trim().min(1).max(200).optional(),
}).strict();
const answerSchema = revisionSchema.extend({
  questionSetId: z.string().min(1).max(200),
  answers: z.array(z.object({
    questionId: z.string().min(1),
    optionId: z.string().min(1).nullable().optional(),
    value: z.string().max(4_000).optional(),
  }).strict()).min(1).max(3),
}).strict();
const confirmBriefSchema = revisionSchema.extend({ brief: featureBriefSchema }).strict();
const artifactsSchema = revisionSchema.extend({ artifacts: artifactBundleSchema }).strict();
const revisionRequestSchema = revisionSchema.extend({ instruction: z.string().trim().min(1).max(4_000) }).strict();
const discussionRequestSchema = revisionSchema.extend({
  message: z.string().trim().min(1).max(4_000),
  context: z.enum(PLANNER_DISCUSSION_CONTEXTS).optional(),
}).strict();
const patchItemSchema = revisionSchema.extend({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(32_000).optional(),
  acceptance: z.string().max(16_000).optional(),
  priority: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
  dependsOnIds: z.array(z.string().min(1)).max(20).optional(),
}).strict();
const moveItemSchema = revisionSchema.extend({ direction: z.enum(['up', 'down']) }).strict();
const mergeSchema = revisionSchema.extend({
  itemIds: z.array(z.string().min(1)).min(2).max(20),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(32_000).optional(),
  acceptance: z.string().max(16_000).optional(),
  priority: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]).optional(),
}).strict();

export default defineRoutes((ctx) => {
  const planner = ctx.services.get('planner');
  const workspace = ctx.services.get('workspace');

  const requireSession = (user: AuthUser | null, id: string) => {
    const session = planner.get(id);
    if (!session || !user || !workspace.canAccessWorkspace(user, session.workspaceId)) {
      throw notFound('planning session not found');
    }
    return session;
  };
  const action = <T>(fn: () => T): T => {
    try {
      return fn();
    } catch (err) {
      if (err instanceof PlannerRevisionConflict || err instanceof PlannerQuestionSetConflict) {
        throw new HttpError(409, err.message);
      }
      throw badRequest(String(err instanceof Error ? err.message : err));
    }
  };
  const asyncAction = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof PlannerRevisionConflict || err instanceof PlannerQuestionSetConflict) {
        throw new HttpError(409, err.message);
      }
      throw badRequest(String(err instanceof Error ? err.message : err));
    }
  };

  return [
    route({
      method: 'GET', path: '/api/workspaces/:id/ideas', access: 'planner:read',
      handler: ({ params, user }) => {
        workspace.requireAccessible(user, params.id);
        return { sessions: planner.list(params.id), legacyActiveCount: planner.legacyActiveCount(params.id) };
      },
    }),
    route({
      method: 'POST', path: '/api/ideas', access: 'planner:manage', body: createSchema,
      handler: ({ body, user }) => {
        workspace.requireAccessible(user, body.workspaceId);
        const session = action(() => planner.create(body, user!.username));
        const started = action(() => planner.startClarification(session.id, session.revision, user!.username));
        return created({ session: started });
      },
    }),
    route({
      method: 'GET', path: '/api/ideas/:id', access: 'planner:read',
      handler: ({ params, user }) => {
        requireSession(user, params.id);
        return planner.detail(params.id, user!)!;
      },
    }),
    route({ method: 'POST', path: '/api/ideas/:id/clarify', access: 'planner:manage', body: revisionSchema,
      handler: ({ params, body, user }) => { requireSession(user, params.id); return { session: action(() => planner.startClarification(params.id, body.expectedRevision, user!.username)) }; } }),
    route({ method: 'POST', path: '/api/ideas/:id/answers', access: 'planner:manage', body: answerSchema,
      handler: ({ params, body, user }) => { requireSession(user, params.id); return { session: action(() => planner.answer(params.id, body.expectedRevision, body, user!.username)) }; } }),
    route({ method: 'POST', path: '/api/ideas/:id/confirm-brief', access: 'planner:manage', body: confirmBriefSchema,
      handler: ({ params, body, user }) => { requireSession(user, params.id); return { session: action(() => planner.confirmBrief(params.id, body.expectedRevision, body.brief, user!.username)) }; } }),
    route({ method: 'PUT', path: '/api/ideas/:id/artifacts', access: 'planner:manage', body: artifactsSchema,
      handler: ({ params, body, user }) => { requireSession(user, params.id); return { session: action(() => planner.saveArtifacts(params.id, body.expectedRevision, body.artifacts)) }; } }),
    route({ method: 'POST', path: '/api/ideas/:id/create-artifacts', access: 'planner:manage', body: revisionSchema,
      handler: ({ params, body, user }) => { requireSession(user, params.id); return { session: action(() => planner.createArtifacts(params.id, body.expectedRevision, user!.username)) }; } }),
    route({ method: 'POST', path: '/api/ideas/:id/analyze', access: 'planner:manage', body: revisionSchema,
      handler: ({ params, body, user }) => { requireSession(user, params.id); return { session: action(() => planner.retryAnalysis(params.id, body.expectedRevision, user!.username)) }; } }),
    route({ method: 'POST', path: '/api/ideas/:id/retry', access: 'planner:manage', body: revisionSchema,
      handler: ({ params, body, user }) => { requireSession(user, params.id); return { session: action(() => planner.retry(params.id, body.expectedRevision, user!.username)) }; } }),
    route({ method: 'POST', path: '/api/ideas/:id/revision', access: 'planner:manage', body: revisionRequestSchema,
      handler: ({ params, body, user }) => { requireSession(user, params.id); return { session: action(() => planner.requestRevision(params.id, body.expectedRevision, body.instruction, user!.username)) }; } }),
    route({ method: 'POST', path: '/api/ideas/:id/discuss', access: 'planner:manage', body: discussionRequestSchema,
      handler: ({ params, body, user }) => { requireSession(user, params.id); return { session: action(() => planner.discuss(params.id, body.expectedRevision, body.message, body.context, user!.username)) }; } }),
    route({ method: 'POST', path: '/api/ideas/:id/apply-revision', access: 'planner:manage', body: revisionSchema,
      handler: ({ params, body, user }) => { requireSession(user, params.id); return { session: action(() => planner.applyRevision(params.id, body.expectedRevision, user!.username)) }; } }),
    route({ method: 'POST', path: '/api/ideas/:id/discard-revision', access: 'planner:manage', body: revisionSchema,
      handler: ({ params, body, user }) => { requireSession(user, params.id); return { session: action(() => planner.discardRevision(params.id, body.expectedRevision)) }; } }),
    route({ method: 'POST', path: '/api/ideas/:id/prepare-tasks', access: 'planner:manage', body: revisionSchema,
      handler: ({ params, body, user }) => { requireSession(user, params.id); return { session: action(() => planner.prepareTasks(params.id, body.expectedRevision, user!.username)) }; } }),
    route({ method: 'PATCH', path: '/api/ideas/:id/items/:itemId', access: 'planner:manage', body: patchItemSchema,
      handler: ({ params, body, user }) => { requireSession(user, params.id); const { expectedRevision, ...fields } = body; return { session: action(() => planner.updateRefinementItem(params.id, expectedRevision, params.itemId, fields)) }; } }),
    route({ method: 'POST', path: '/api/ideas/:id/items/:itemId/move', access: 'planner:manage', body: moveItemSchema,
      handler: ({ params, body, user }) => { requireSession(user, params.id); return { session: action(() => planner.moveRefinementItem(params.id, body.expectedRevision, params.itemId, body.direction)) }; } }),
    route({ method: 'POST', path: '/api/ideas/:id/items/:itemId/dismiss', access: 'planner:manage', body: revisionSchema,
      handler: ({ params, body, user }) => { requireSession(user, params.id); return { session: action(() => planner.dismissRefinementItem(params.id, body.expectedRevision, params.itemId)) }; } }),
    route({ method: 'POST', path: '/api/ideas/:id/items/merge', access: 'planner:manage', body: mergeSchema,
      handler: ({ params, body, user }) => { requireSession(user, params.id); const { expectedRevision, itemIds, ...fields } = body; return { session: action(() => planner.mergeRefinementItems(params.id, expectedRevision, itemIds, fields)) }; } }),
    route({ method: 'POST', path: '/api/ideas/:id/launch', access: 'planner:execute', body: launchSchema,
      handler: ({ params, body, user }) => { requireSession(user, params.id); return { session: action(() => planner.launch(params.id, body.expectedRevision, user!.username, body.targetBranch)) }; } }),
    route({ method: 'POST', path: '/api/ideas/:id/stop', access: 'planner:manage', body: revisionSchema,
      handler: async ({ params, body, user }) => { requireSession(user, params.id); return { session: await asyncAction(() => planner.stop(params.id, body.expectedRevision)) }; } }),
    route({ method: 'POST', path: '/api/ideas/:id/cancel', access: 'planner:manage', body: revisionSchema,
      handler: async ({ params, body, user }) => { requireSession(user, params.id); return { session: await asyncAction(() => planner.cancel(params.id, body.expectedRevision)) }; } }),
  ];
});
