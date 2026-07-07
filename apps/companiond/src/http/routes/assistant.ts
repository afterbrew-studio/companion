import { z } from 'zod';
import { route, type CompiledRoute } from '../router.js';
import type { ApiDeps } from '../deps.js';

const messageSchema = z.object({
  text: z.string().min(1).max(32_000),
  /** Repo the conversation currently focuses on (the panel's scope select). */
  repo: z.string().max(200).optional(),
});

const askSchema = z.object({
  requestId: z.string(),
  response: z.object({
    mode: z.enum(['allow', 'allow_session', 'allow_always', 'deny']).optional(),
    optionId: z.string().optional(),
    text: z.string().optional(),
  }),
});

/**
 * AI Help. Every route is 'any' (each signed-in role gets an assistant) and
 * resolves the CALLER's own conversation run — there is no way to address
 * another user's assistant. Action authority comes from the scoped token the
 * assistant service mints, which carries the caller's own role.
 */
export function assistantRoutes(deps: ApiDeps): CompiledRoute[] {
  return [
    route({
      method: 'GET',
      path: '/api/assistant',
      access: 'any',
      handler: ({ user }) => deps.assistant.info(user!),
    }),

    route({
      method: 'POST',
      path: '/api/assistant/session',
      access: 'any',
      handler: async ({ user }) => {
        const run = await deps.assistant.ensureRun(user!);
        return { run, pendingAsks: deps.assistant.info(user!).pendingAsks };
      },
    }),

    route({
      method: 'POST',
      path: '/api/assistant/message',
      access: 'any',
      body: messageSchema,
      handler: async ({ user, body }) => deps.assistant.send(user!, body.text, body.repo),
    }),

    route({
      method: 'GET',
      path: '/api/assistant/history',
      access: 'any',
      handler: async ({ user, query }) => {
        const beforeRaw = query.get('before');
        const before = beforeRaw === null ? null : Number(beforeRaw);
        const limit = Math.min(Number(query.get('limit')) || 300, 1000);
        return deps.assistant.history(user!, Number.isFinite(before as number) ? before : null, limit);
      },
    }),

    route({
      method: 'POST',
      path: '/api/assistant/ask',
      access: 'any',
      body: askSchema,
      handler: async ({ user, body }) => {
        await deps.assistant.respondAsk(user!, body.requestId, body.response);
        return { ok: true };
      },
    }),

    route({
      method: 'POST',
      path: '/api/assistant/abort',
      access: 'any',
      handler: async ({ user }) => {
        await deps.assistant.abort(user!);
        return { ok: true };
      },
    }),

    route({
      method: 'POST',
      path: '/api/assistant/reset',
      access: 'any',
      handler: async ({ user }) => {
        await deps.assistant.reset(user!);
        return { ok: true };
      },
    }),
  ];
}
