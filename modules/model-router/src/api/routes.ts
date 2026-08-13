import { z } from 'zod';
import { HttpError, defineRoutes, route } from '@moxxy/companion-sdk/server';
import '../contract/index.js';

const profileId = z.enum(['economy', 'balanced', 'frontier', 'reviewer']);
const profile = z.object({
  id: profileId,
  label: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300),
  models: z.array(z.string().trim().min(1).max(200)).max(12),
  unavailable: z.enum(['fallback', 'fail']),
}).strict();
const rule = z.object({
  id: z.string().trim().min(1).max(100).regex(/^[a-z0-9.-]+$/),
  label: z.string().trim().min(1).max(120),
  task: z.string().trim().min(1).max(120).regex(/^[a-z0-9.-]+$/),
  phase: z.string().trim().min(1).max(80).regex(/^[a-z0-9.-]+$/),
  profileId,
  enabled: z.boolean(),
}).strict();
const update = z.object({
  expectedRevision: z.number().int().positive(),
  enabled: z.boolean(),
  profiles: z.array(profile).length(4),
  rules: z.array(rule).max(100),
}).strict().superRefine((value, ctx) => {
  const ids = value.profiles.map((item) => item.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'profile ids must be unique' });
  for (const item of value.profiles) {
    if (new Set(item.models).size !== item.models.length) {
      ctx.addIssue({ code: 'custom', message: `${item.label} contains a model more than once` });
    }
  }
  const ruleIds = value.rules.map((item) => item.id);
  if (new Set(ruleIds).size !== ruleIds.length) ctx.addIssue({ code: 'custom', message: 'rule ids must be unique' });
  const matches = value.rules.map((item) => `${item.task}:${item.phase}`);
  if (new Set(matches).size !== matches.length) {
    ctx.addIssue({ code: 'custom', message: 'only one rule may target a task and phase' });
  }
});

export default defineRoutes((ctx) => {
  const router = ctx.services.get('model-router');
  return [
    route({
      method: 'GET',
      path: '/api/model-router',
      access: 'model-router:read',
      handler: () => router.snapshot(),
    }),
    route({
      method: 'PUT',
      path: '/api/model-router/policy',
      access: 'model-router:manage',
      body: update,
      handler: ({ body }) => {
        if (router.policy().revision !== body.expectedRevision) {
          throw new HttpError(409, 'Model Router policy changed in another session; reload and try again');
        }
        return { policy: router.updatePolicy(body) };
      },
    }),
  ];
});
