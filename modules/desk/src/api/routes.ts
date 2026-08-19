import { z } from 'zod';
import { defineRoutes, route } from '@moxxy/companion-sdk/server';
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
