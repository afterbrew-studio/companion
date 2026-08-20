import { z } from 'zod';
import { badRequest, created, defineRoutes, route } from '@moxxy/companion-sdk/server';
import '../contract/index.js';

const contextSchema = z.object({
  kind: z.enum(['pull-request', 'issue']),
  repo: z.string().trim().min(3).max(200),
  number: z.number().int().positive(),
});

const createSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  workspaceId: z.string().trim().min(1).max(100),
  repo: z.string().trim().min(3).max(200).nullable().optional(),
  runnerId: z.string().trim().min(1).max(100).nullable().optional(),
  harness: z.string().trim().min(1).max(100).nullable().optional(),
  contexts: z.array(contextSchema).max(8).default([]),
});

const terminalSchema = z.object({
  workspaceId: z.string().trim().min(1).max(100),
  runnerId: z.string().trim().min(1).max(100).nullable().optional(),
  harness: z.string().trim().min(1).max(100).nullable().optional(),
});

const launchMissionSchema = z.object({
  title: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(32_000),
  repo: z.string().trim().min(3).max(200).nullable().default(null),
  contexts: z.array(contextSchema).max(8).default([]),
});

const launchPlanSchema = z.object({
  workspaceId: z.string().trim().min(1).max(100),
  missions: z.array(launchMissionSchema).min(1).max(6),
});

const updateSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    repo: z.string().trim().min(3).max(200).nullable().optional(),
    runnerId: z.string().trim().min(1).max(100).nullable().optional(),
    harness: z.string().trim().min(1).max(100).nullable().optional(),
    contexts: z.array(contextSchema).max(8).optional(),
    archived: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'provide at least one mission change');

const messageSchema = z.object({ text: z.string().trim().min(1).max(32_000) });
const askSchema = z.object({
  requestId: z.string().min(1).max(200),
  response: z.object({
    mode: z.enum(['allow', 'allow_session', 'allow_always', 'deny']).optional(),
    optionId: z.string().max(200).optional(),
    text: z.string().max(32_000).optional(),
  }),
});

export default defineRoutes((ctx) => {
  const desk = ctx.services.get('desk');
  return [
    route({
      method: 'POST',
      path: '/api/desk/terminal',
      access: ['workspaces:read', 'runs:act'],
      body: terminalSchema,
      handler: ({ user, body }) => desk.terminal(user!, body),
    }),
    route({
      method: 'POST',
      path: '/api/desk/terminal/reset',
      access: ['workspaces:read', 'runs:act'],
      body: z.object({ workspaceId: z.string().trim().min(1).max(100) }),
      handler: ({ user, body }) => desk.resetTerminal(user!, body.workspaceId),
    }),
    route({
      method: 'GET',
      path: '/api/desk/launch-plans',
      access: ['workspaces:read', 'runs:read'],
      handler: ({ user, query }) => {
        const workspaceId = query.get('workspace')?.trim() ?? '';
        if (!workspaceId || workspaceId.length > 100) throw badRequest('valid workspace is required');
        return { plans: desk.launchPlanList(user!, workspaceId) };
      },
    }),
    route({
      method: 'POST',
      path: '/api/desk/launch-plans',
      access: ['workspaces:read', 'runs:act'],
      allowDelegatedWrite: true,
      body: launchPlanSchema,
      handler: ({ user, body }) => created({
        plan: desk.prepareLaunchPlan(user!, body.workspaceId, body.missions),
      }),
    }),
    route({
      method: 'POST',
      path: '/api/desk/launch-plans/:id/execute',
      access: ['workspaces:read', 'runs:act'],
      handler: async ({ user, params }) => ({ plan: await desk.executeLaunchPlan(user!, params.id) }),
    }),
    route({
      method: 'POST',
      path: '/api/desk/launch-plans/:id/cancel',
      access: ['workspaces:read', 'runs:act'],
      handler: ({ user, params }) => ({ plan: desk.cancelLaunchPlan(user!, params.id) }),
    }),
    route({
      method: 'GET',
      path: '/api/desk/missions',
      access: ['workspaces:read', 'runs:read'],
      handler: ({ user, query }) => ({ missions: desk.list(user!, query.get('archived') === '1') }),
    }),
    route({
      method: 'POST',
      path: '/api/desk/missions',
      access: ['workspaces:read', 'runs:act'],
      body: createSchema,
      handler: ({ user, body }) => desk.create(user!, body),
    }),
    route({
      method: 'GET',
      path: '/api/desk/missions/:id',
      access: ['workspaces:read', 'runs:read'],
      handler: ({ user, params }) => desk.get(user!, params.id),
    }),
    route({
      method: 'PATCH',
      path: '/api/desk/missions/:id',
      access: ['workspaces:read', 'runs:act'],
      body: updateSchema,
      handler: ({ user, params, body }) => desk.update(user!, params.id, body),
    }),
    route({
      method: 'POST',
      path: '/api/desk/missions/:id/message',
      access: ['workspaces:read', 'runs:act'],
      body: messageSchema,
      handler: async ({ user, params, body }) => desk.send(user!, params.id, body.text),
    }),
    route({
      method: 'POST',
      path: '/api/desk/missions/:id/session',
      access: ['workspaces:read', 'runs:act'],
      handler: async ({ user, params }) => desk.session(user!, params.id),
    }),
    route({
      method: 'GET',
      path: '/api/desk/missions/:id/history',
      access: ['workspaces:read', 'runs:read'],
      handler: async ({ user, params, query }) => {
        const beforeRaw = query.get('before');
        const before = beforeRaw === null ? null : Number(beforeRaw);
        const limit = Math.min(Math.max(Number(query.get('limit')) || 300, 1), 1000);
        return desk.history(user!, params.id, Number.isFinite(before as number) ? before : null, limit);
      },
    }),
    route({
      method: 'POST',
      path: '/api/desk/missions/:id/ask',
      access: ['workspaces:read', 'runs:act'],
      body: askSchema,
      handler: async ({ user, params, body }) => {
        await desk.respondAsk(user!, params.id, body.requestId, body.response);
        return { ok: true };
      },
    }),
    route({
      method: 'POST',
      path: '/api/desk/missions/:id/abort',
      access: ['workspaces:read', 'runs:act'],
      handler: async ({ user, params }) => {
        await desk.abort(user!, params.id);
        return { ok: true };
      },
    }),
  ];
});
