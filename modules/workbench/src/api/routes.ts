import { z } from 'zod';
import { badRequest, created, defineRoutes, route } from '@moxxy/companion-sdk/server';
import { WORKBENCH_ACTIONS } from './workbench-actions.js';

const id = z.string().trim().min(1).max(200);
const repo = z.string().regex(/^[\w.-]+\/[\w.-]+$/).max(200);
const number = z.number().int().positive();
const actionRequestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('run.approve'),
    runId: id,
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().max(64_000).optional(),
  }),
  z.object({ action: z.literal('run.discard'), runId: id }),
  z.object({
    action: z.literal('pr-review.apply'),
    repo,
    number,
    mode: z.enum(['full', 'comments', 'summary']).optional(),
  }),
  z.object({ action: z.literal('pr-review.dismiss'), repo, number }),
  z.object({ action: z.literal('issue-triage.apply'), repo, number, comment: z.boolean().optional() }),
  z.object({ action: z.literal('issue-triage.dismiss'), repo, number }),
  z.object({ action: z.literal('board.merge'), taskId: id }),
  z.object({ action: z.literal('board.retry'), taskId: id }),
  z.object({
    action: z.literal('spec.create'),
    repo,
    title: z.string().trim().min(3).max(200),
    content: z.string().min(1).max(64_000),
  }),
  z.object({
    action: z.literal('doc.create'),
    repo: repo.optional(),
    title: z.string().trim().min(3).max(200),
    content: z.string().min(1).max(64_000),
  }),
]);
const prepareSchema = z.object({
  workspaceId: z.string().trim().min(1).max(100),
  request: actionRequestSchema,
  source: z.enum(['mcp', 'ui']).optional(),
});
const actionStatuses = ['pending', 'executing', 'completed', 'failed', 'cancelled', 'expired'] as const;

/** One authenticated, workspace-scoped read for every current decision. */
export default defineRoutes((ctx) => {
  const workbench = ctx.services.get('workbench');
  const actionRoutes = WORKBENCH_ACTIONS.flatMap((definition) => [
    route({
      method: 'POST',
      path: `/api/workbench/actions/${definition.id}/prepare` as const,
      access: definition.access,
      allowDelegatedWrite: true,
      body: prepareSchema,
      handler: async ({ body, user }) => {
        if (body.request.action !== definition.id) throw badRequest('request action does not match route');
        const source = user!.sessionAccess === 'read-only' ? 'assistant' : (body.source ?? 'ui');
        return created({
          action: await workbench.actions.prepare(user!, body.workspaceId, body.request, source),
        });
      },
    }),
    route({
      method: 'POST',
      path: `/api/workbench/actions/${definition.id}/:id/execute` as const,
      access: definition.access,
      handler: async ({ params, user }) => ({
        action: await workbench.actions.execute(user!, params.id, definition.id),
      }),
    }),
  ]);
  return [
    route({
      method: 'GET',
      path: '/api/workbench/decisions',
      access: 'workbench:read',
      handler: ({ query, user }) => {
        const workspaceId = query.get('workspace')?.trim() ?? '';
        if (!workspaceId) throw badRequest('workspace is required');
        if (workspaceId.length > 100) throw badRequest('workspace is too long');
        return workbench.decisions(user!, workspaceId);
      },
    }),
    route({
      method: 'GET',
      path: '/api/workbench/actions/catalog',
      access: 'workbench:read',
      // MCP and AI Help should discover only actions this live role can
      // actually prepare. Besides reducing noise, this naturally hides
      // actions owned by a disabled optional module because its permissions
      // are absent from the effective grid.
      handler: ({ user }) => ({
        actions: workbench.actions
          .catalog()
          .filter((definition) =>
            definition.access.every((permission) => ctx.rbac.allows(user!, permission)),
          ),
      }),
    }),
    route({
      method: 'GET',
      path: '/api/workbench/actions',
      access: 'workbench:read',
      handler: ({ query, user }) => {
        const workspaceId = query.get('workspace')?.trim() || undefined;
        if (workspaceId && workspaceId.length > 100) throw badRequest('workspace is too long');
        const statusRaw = query.get('status');
        const status = statusRaw === null ? undefined : actionStatuses.find((item) => item === statusRaw);
        if (statusRaw !== null && !status) throw badRequest('invalid action status');
        return { actions: workbench.actions.list(user!, { workspaceId, status }) };
      },
    }),
    ...actionRoutes,
    route({
      method: 'POST',
      path: '/api/workbench/actions/:id/cancel',
      access: 'workbench:read',
      handler: ({ params, user }) => ({ action: workbench.actions.cancel(user!, params.id) }),
    }),
  ];
});
