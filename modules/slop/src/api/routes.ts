import { z } from 'zod';
import { accepted, badRequest, created, defineRoutes, notFound, route } from '@moxxy/companion-sdk/server';
import type { AuthUser } from '@moxxy/companion-contracts';
import '../contract/index.js';

const saveRuleSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().max(300).default(''),
  instructions: z.string().trim().min(8).max(8_000),
});

const patchRuleSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  description: z.string().max(300).optional(),
  instructions: z.string().trim().min(8).max(8_000).optional(),
});

const generateRuleSchema = z.object({
  prompt: z.string().trim().min(3).max(2_000),
});

const toggleRuleSchema = z.object({
  workspaceId: z.string().min(1),
  enabled: z.boolean(),
});

const applySchema = z.object({
  action: z.enum(['none', 'label', 'comment', 'request_changes', 'close']).optional(),
  accountId: z.string().optional(),
});

const moveToRefinementSchema = z.object({ workspaceId: z.string().min(1).max(100) });

export default defineRoutes((ctx) => {
  const slop = ctx.services.get('slop');
  const workspace = ctx.services.get('workspace');
  const code = ctx.services.get('code');

  // A private workspace the caller isn't in reads as "not found" — the house
  // convention (existence is not leaked).
  const requireWorkspace = (user: AuthUser | null, id: string): void => {
    workspace.requireAccessible(user, id);
  };

  const requireRepo = async (user: AuthUser | null, repo: string): Promise<void> => {
    if (!user || !workspace.canAccessRepo(user, repo)) throw notFound(`repo ${repo} not connected`);
    const { client } = await code.githubAccounts.verifiedClientFor('fetch', repo, { username: user.username });
    if (!client) throw notFound(`repo ${repo} not connected`);
  };

  // Custom rules are workspace-owned: mutating one you can't reach reads as
  // "not found". Built-in ids fall through — the service rejects those edits
  // with the clearer built-in message.
  const requireRuleAccess = (user: AuthUser | null, id: string): void => {
    if (id.startsWith('builtin-')) return;
    const rule = slop.customRule(id);
    if (!rule || !user || rule.workspaceId === null || !workspace.canAccessWorkspace(user, rule.workspaceId)) {
      throw notFound('rule not found');
    }
  };

  // A detection in a repo the caller can't reach reads as "not found".
  const requireDetection = async (user: AuthUser | null, id: string) => {
    const detection = slop.getDetection(id);
    if (!detection || !user || !workspace.canAccessRepo(user, detection.repo)) {
      throw notFound('detection not found');
    }
    await requireRepo(user, detection.repo);
    return detection;
  };

  return [
    route({
      method: 'GET',
      path: '/api/workspaces/:id/slop',
      access: 'slop:read',
      handler: async ({ params, user }) => {
        requireWorkspace(user, params.id);
        const detections = slop.listByWorkspace(params.id);
        const visible = await Promise.all(
          detections.map((detection) => requireRepo(user, detection.repo).then(() => true).catch(() => false)),
        );
        return { detections: detections.filter((_, index) => visible[index]) };
      },
    }),

    route({
      method: 'GET',
      path: '/api/workspaces/:id/slop-rules',
      access: 'slop:read',
      handler: ({ params, user }) => {
        requireWorkspace(user, params.id);
        return { rules: slop.rules(params.id) };
      },
    }),

    route({
      method: 'POST',
      path: '/api/workspaces/:id/slop-rules',
      access: 'slop:manage',
      body: saveRuleSchema,
      handler: ({ params, body, user }) => {
        requireWorkspace(user, params.id);
        return created({ rule: slop.saveRule(params.id, body) });
      },
    }),

    // Synchronous like refinement's method drafting: the editor waits, then
    // prefills the fields with the draft — nothing is stored until the user saves.
    route({
      method: 'POST',
      path: '/api/workspaces/:id/slop-rules/generate',
      access: 'slop:manage',
      body: generateRuleSchema,
      handler: async ({ params, body, user }) => {
        requireWorkspace(user, params.id);
        try {
          return { draft: await slop.generateRule(body.prompt) };
        } catch (err) {
          throw badRequest(
            err instanceof z.ZodError
              ? 'the agent reply was not a valid rule draft — try rephrasing'
              : String(err instanceof Error ? err.message : err),
          );
        }
      },
    }),

    route({
      method: 'PUT',
      path: '/api/slop-rules/:id',
      access: 'slop:manage',
      body: patchRuleSchema,
      handler: ({ params, body, user }) => {
        requireRuleAccess(user, params.id);
        try {
          return { rule: slop.updateRule(params.id, body) };
        } catch (err) {
          throw badRequest(String(err instanceof Error ? err.message : err));
        }
      },
    }),

    route({
      method: 'DELETE',
      path: '/api/slop-rules/:id',
      access: 'slop:manage',
      handler: ({ params, user }) => {
        requireRuleAccess(user, params.id);
        try {
          slop.deleteRule(params.id);
        } catch (err) {
          throw badRequest(String(err instanceof Error ? err.message : err));
        }
        return { ok: true };
      },
    }),

    // Enable/disable a rule for a workspace (the only mutation built-ins allow).
    route({
      method: 'POST',
      path: '/api/slop-rules/:id/toggle',
      access: 'slop:manage',
      body: toggleRuleSchema,
      handler: ({ params, body, user }) => {
        requireWorkspace(user, body.workspaceId);
        requireRuleAccess(user, params.id);
        try {
          slop.setRuleEnabled(body.workspaceId, params.id, body.enabled);
        } catch (err) {
          throw badRequest(String(err instanceof Error ? err.message : err));
        }
        return { ok: true };
      },
    }),

    // Validation (unknown PR, no rules, no clone) surfaces as a 400; only the
    // minutes-long agent phase is fire-and-forget — the result lands over WS
    // (slop.changed), and an agent-phase failure as a stored 'failed' row.
    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/prs/:number/slop-detect',
      access: 'slop:act',
      handler: async ({ params, user }) => {
        const repo = `${params.owner}/${params.name}`;
        await requireRepo(user, repo);
        const prNumber = Number(params.number);
        try {
          slop.validateDetect(repo, prNumber, user!.username);
        } catch (err) {
          throw badRequest(String(err instanceof Error ? err.message : err));
        }
        void slop.detect(repo, prNumber, user!.username).catch(() => undefined);
        return accepted({ queued: true });
      },
    }),

    route({
      method: 'GET',
      path: '/api/repos/:owner/:name/prs/:number/slop',
      access: 'slop:read',
      handler: async ({ params, user }) => {
        const repo = `${params.owner}/${params.name}`;
        await requireRepo(user, repo);
        return { detections: slop.listForPr(repo, Number(params.number)) };
      },
    }),

    route({
      method: 'GET',
      path: '/api/slop/:id',
      access: 'slop:read',
      handler: async ({ params, user }) => ({ detection: await requireDetection(user, params.id) }),
    }),

    route({
      method: 'POST',
      path: '/api/slop/:id/apply',
      access: 'slop:act',
      body: applySchema,
      handler: async ({ params, body, user }) => {
        await requireDetection(user, params.id);
        try {
          return await slop.apply(params.id, { ...body, userId: user!.username });
        } catch (err) {
          throw badRequest(String(err instanceof Error ? err.message : err));
        }
      },
    }),

    route({
      method: 'POST',
      path: '/api/slop/:id/dismiss',
      access: 'slop:act',
      handler: async ({ params, user }) => {
        await requireDetection(user, params.id);
        slop.dismiss(params.id);
        return { ok: true };
      },
    }),

    route({
      method: 'POST',
      path: '/api/slop/:id/move-to-refinement',
      access: 'slop:act',
      body: moveToRefinementSchema,
      handler: async ({ params, body, user }) => {
        const detection = await requireDetection(user, params.id);
        requireWorkspace(user, body.workspaceId);
        if (!code.repos.inWorkspace(detection.repo, body.workspaceId)) {
          throw notFound(`repo ${detection.repo} not connected`);
        }
        try {
          return slop.moveToRefinement(params.id, body.workspaceId);
        } catch (err) {
          throw badRequest(String(err instanceof Error ? err.message : err));
        }
      },
    }),
  ];
});
