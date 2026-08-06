import { z } from 'zod';
import { badRequest, created, defineRoutes, forbidden, notFound, route } from '@moxxy/companion-sdk/server';

const attachmentSchema = z.object({
  name: z.string().min(1).max(200),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  content: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).max(1_200_000),
});
const attachmentsSchema = z
  .array(attachmentSchema)
  .max(5)
  .refine((attachments) => attachments.reduce((total, attachment) => total + attachment.content.length, 0) <= 1_500_000, 'images are too large in total')
  .default([]);

const prioritySchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);

// Not checked against the catalog on purpose: the catalog is capability and
// moves with the machines, while a card's choice must survive a provider being
// switched off for a week. Dispatch resolves it per run and falls back there.
const modelSchema = z.string().max(200).nullable();

const createTaskSchema = z.object({
  workspaceId: z.string().min(1).max(100),
  repo: z.string().min(3).max(200),
  targetBranch: z.string().trim().min(1).max(200),
  title: z.string().min(1).max(200),
  description: z.string().max(20_000).default(''),
  acceptance: z.string().max(10_000).default(''),
  specId: z.string().max(100).nullable().default(null),
  attachments: attachmentsSchema,
  dependsOn: z.array(z.string().max(40)).max(20).default([]),
  model: modelSchema.default(null),
  priority: prioritySchema.default(2),
  queue: z.boolean().default(false),
});

const updateTaskSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(20_000).optional(),
  acceptance: z.string().max(10_000).optional(),
  specId: z.string().max(100).nullable().optional(),
  attachments: attachmentsSchema.optional(),
  dependsOn: z.array(z.string().max(40)).max(20).optional(),
  model: modelSchema.optional(),
  priority: prioritySchema.optional(),
});

const moveTaskSchema = z.object({
  to: z.enum(['backlog', 'ready', 'done']),
});

const workerSchema = z.object({
  workspaceId: z.string().min(1).max(100),
  name: z.string().min(1).max(60),
  role: z.enum(['developer', 'reviewer']),
});

const updateWorkerSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  role: z.enum(['developer', 'reviewer']).optional(),
  enabled: z.boolean().optional(),
});

const configSchema = z.object({
  workspaceId: z.string().min(1).max(100),
  autoReview: z.boolean().optional(),
  reviewerWorkerId: z.string().max(100).nullable().optional(),
  autoMerge: z.boolean().optional(),
  mergeMethod: z.enum(['merge', 'squash', 'rebase']).optional(),
  mergeAccountId: z.string().max(100).nullable().optional(),
  autoFixCi: z.boolean().optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
});

export default defineRoutes((ctx) => {
  const board = ctx.services.get('board');
  const code = ctx.services.get('code');
  const workspace = ctx.services.get('workspace');

  return [
    route({
      method: 'GET',
      path: '/api/board',
      access: 'board:read',
      handler: ({ user, query }) => {
        const workspaceId = query.get('workspace') ?? '';
        if (!workspaceId) throw badRequest('workspace is required');
        if (!workspace.canAccessWorkspace(user!, workspaceId)) throw forbidden('no access to that workspace');
        const rawLimit = query.get('doneLimit');
        if (rawLimit !== null && !/^\d+$/.test(rawLimit)) throw badRequest('doneLimit must be an integer');
        const doneLimit = rawLimit === null ? 100 : Number(rawLimit);
        if (!Number.isSafeInteger(doneLimit) || doneLimit < 1 || doneLimit > 100) {
          throw badRequest('doneLimit must be between 1 and 100');
        }
        const rawOffset = query.get('doneOffset');
        if (rawOffset !== null && !/^\d+$/.test(rawOffset)) throw badRequest('doneOffset must be an integer');
        const doneOffset = rawOffset === null ? 0 : Number(rawOffset);
        if (!Number.isSafeInteger(doneOffset) || doneOffset < 0 || doneOffset > 1_000_000) {
          throw badRequest('doneOffset must be between 0 and 1000000');
        }
        const doneRepo = query.get('doneRepo')?.trim() || undefined;
        if (doneRepo && doneRepo.length > 200) throw badRequest('doneRepo is too long');
        return board.listBoard(user!, workspaceId, { doneLimit, doneOffset, doneRepo });
      },
    }),

    route({
      method: 'GET',
      path: '/api/board/tasks/:id',
      access: 'board:read',
      handler: ({ params, user }) => {
        const detail = board.getTask(user!, params.id);
        if (!detail) throw notFound('task not found');
        return detail;
      },
    }),

    route({
      method: 'POST',
      path: '/api/board/tasks',
      access: 'board:manage',
      body: createTaskSchema,
      handler: ({ body, user }) => {
        if (!workspace.canAccessWorkspace(user!, body.workspaceId)) throw forbidden('no access to that workspace');
        if (!code.repos.inWorkspace(body.repo, body.workspaceId)) {
          throw forbidden('repository is not connected to that workspace');
        }
        try {
          return created({ task: board.createTask({ ...body, createdBy: user!.username }) });
        } catch (err) {
          throw badRequest(String(err instanceof Error ? err.message : err));
        }
      },
    }),

    route({
      method: 'PATCH',
      path: '/api/board/tasks/:id',
      access: 'board:manage',
      body: updateTaskSchema,
      handler: ({ params, body, user }) => {
        if (!board.getTask(user!, params.id)) throw notFound('task not found');
        try {
          return { task: board.updateTask(params.id, body) };
        } catch (err) {
          throw badRequest(String(err instanceof Error ? err.message : err));
        }
      },
    }),

    route({
      method: 'POST',
      path: '/api/board/tasks/:id/move',
      access: 'board:manage',
      body: moveTaskSchema,
      handler: async ({ params, body, user }) => {
        if (!board.getTask(user!, params.id)) throw notFound('task not found');
        try {
          return { task: await board.moveTask(params.id, body.to) };
        } catch (err) {
          throw badRequest(String(err instanceof Error ? err.message : err));
        }
      },
    }),

    route({
      method: 'POST',
      path: '/api/board/tasks/:id/merge',
      access: ['board:read', 'board:manage', 'prs:read', 'prs:act'],
      handler: async ({ params, user }) => {
        if (!board.getTask(user!, params.id)) throw notFound('task not found');
        try {
          return { task: await board.mergeNow(params.id, user!.username) };
        } catch (err) {
          throw badRequest(String(err instanceof Error ? err.message : err));
        }
      },
    }),

    route({
      method: 'DELETE',
      path: '/api/board/tasks/:id',
      access: 'board:manage',
      handler: async ({ params, user }) => {
        if (!board.getTask(user!, params.id)) throw notFound('task not found');
        await board.deleteTask(params.id);
        return { ok: true };
      },
    }),

    /**
     * Spec picker options (soft plan dependency — [] when plan is off). Only
     * id + title cross here, gated on repo access; spec CONTENT stays behind
     * plan's own specs:read routes.
     */
    route({
      method: 'GET',
      path: '/api/board/specs/:owner/:name',
      access: 'board:read',
      handler: ({ params, query, user }) => {
        const repo = `${params.owner}/${params.name}`;
        const workspaceId = query.get('workspace') ?? '';
        if (!workspaceId || !workspace.canAccessWorkspace(user!, workspaceId)) {
          throw forbidden('no access to that workspace');
        }
        if (!code.repos.inWorkspace(repo, workspaceId)) {
          throw forbidden('repository is not connected to that workspace');
        }
        return { specs: board.specOptions(repo, workspaceId) };
      },
    }),

    /**
     * The card model picker's options. Gated on board:manage because only a
     * manager chooses one; a read-only viewer sees the card's stored id and
     * needs no catalog to do it.
     */
    route({
      method: 'GET',
      path: '/api/board/models',
      access: 'board:manage',
      handler: () => board.modelOptions(),
    }),

    route({
      method: 'POST',
      path: '/api/board/workers',
      access: 'board:manage',
      body: workerSchema,
      handler: ({ body, user }) => {
        if (!workspace.canAccessWorkspace(user!, body.workspaceId)) throw forbidden('no access to that workspace');
        return created({ worker: board.createWorker(body.workspaceId, body.name, body.role) });
      },
    }),

    route({
      method: 'PATCH',
      path: '/api/board/workers/:id',
      access: 'board:manage',
      body: updateWorkerSchema,
      handler: ({ params, body }) => {
        try {
          return { worker: board.updateWorker(params.id, body) };
        } catch (err) {
          throw badRequest(String(err instanceof Error ? err.message : err));
        }
      },
    }),

    route({
      method: 'DELETE',
      path: '/api/board/workers/:id',
      access: 'board:manage',
      handler: ({ params }) => {
        try {
          board.deleteWorker(params.id);
        } catch (err) {
          throw badRequest(String(err instanceof Error ? err.message : err));
        }
        return { ok: true };
      },
    }),

    route({
      method: 'PUT',
      path: '/api/board/config',
      access: 'board:manage',
      body: configSchema,
      handler: ({ body, user }) => {
        const { workspaceId, ...patch } = body;
        if (!workspace.canAccessWorkspace(user!, workspaceId)) throw forbidden('no access to that workspace');
        try {
          return { config: board.setConfig(workspaceId, patch) };
        } catch (err) {
          throw badRequest(String(err instanceof Error ? err.message : err));
        }
      },
    }),
  ];
});
