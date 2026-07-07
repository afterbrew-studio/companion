import { z } from 'zod';
import { route, created, notFound, badRequest, type CompiledRoute } from '../router.js';
import { rowToRepo } from '../../store/db.js';
import { log } from '../../log.js';
import type { ApiDeps } from '../deps.js';

const addRepoSchema = z.object({
  fullName: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  workspaceId: z.string().min(1),
});
const automationSchema = z.object({
  autoTriage: z.boolean().optional(),
  digest: z.boolean().optional(),
  staleSweep: z.boolean().optional(),
  prGate: z.boolean().optional(),
  autoMerge: z.boolean().optional(),
});
const moveSchema = z.object({ workspaceId: z.string().min(1) });

export function repoRoutes(deps: ApiDeps): CompiledRoute[] {
  const requireRepo = (owner: string, name: string) => {
    const fullName = `${owner}/${name}`;
    const row = deps.store.repos.get(fullName);
    if (!row) throw notFound(`repo ${fullName} not connected`);
    return { fullName, row };
  };

  return [
    route({
      method: 'GET',
      path: '/api/repos',
      access: 'repos:read',
      handler: () => ({
        repos: deps.store.repos.list().map((row) => ({
          ...rowToRepo(row),
          openIssues: deps.store.issues.list(row.full_name, 'open').length,
        })),
      }),
    }),

    route({
      method: 'POST',
      path: '/api/repos',
      access: 'repos:manage',
      body: addRepoSchema,
      handler: async ({ body }) => {
        const client = deps.github();
        if (!client) throw badRequest('GitHub is not configured (set a PAT first)');
        if (!deps.store.workspaces.get(body.workspaceId)) {
          throw badRequest(`workspace ${body.workspaceId} not found`);
        }
        const meta = await client.repo(body.fullName);
        deps.store.repos.upsert({
          fullName: meta.full_name,
          owner: meta.owner.login,
          name: meta.name,
          defaultBranch: meta.default_branch,
          private: meta.private,
          workspaceId: body.workspaceId,
        });
        // Clone + first sync in the background; the UI follows repos.changed.
        void (async () => {
          try {
            await deps.checkouts.clone(meta.full_name);
            deps.store.repos.setCloneReady(meta.full_name, true);
            await deps.sync.syncRepo(meta.full_name);
          } catch (err) {
            log.warn('repo provisioning failed', { repo: meta.full_name, err: String(err) });
          }
        })();
        deps.broadcast({ t: 'repos.changed' });
        return created({ repo: rowToRepo(deps.store.repos.get(meta.full_name)!) });
      },
    }),

    route({
      method: 'DELETE',
      path: '/api/repos/:owner/:name',
      access: 'repos:manage',
      handler: ({ params }) => {
        const { fullName } = requireRepo(params.owner, params.name);
        deps.store.repos.remove(fullName);
        deps.broadcast({ t: 'repos.changed' });
        return { ok: true };
      },
    }),

    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/workspace',
      access: 'repos:manage',
      body: moveSchema,
      handler: ({ params, body }) => {
        const { fullName } = requireRepo(params.owner, params.name);
        if (!deps.store.workspaces.get(body.workspaceId)) {
          throw badRequest(`workspace ${body.workspaceId} not found`);
        }
        deps.store.repos.setWorkspace(fullName, body.workspaceId);
        deps.broadcast({ t: 'repos.changed' });
        return { repo: rowToRepo(deps.store.repos.get(fullName)!) };
      },
    }),

    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/sync',
      access: 'repos:manage',
      handler: async ({ params }) => {
        const { fullName } = requireRepo(params.owner, params.name);
        return deps.sync.syncRepo(fullName);
      },
    }),

    route({
      method: 'PATCH',
      path: '/api/repos/:owner/:name/github-account',
      access: 'repos:manage',
      body: z.object({ accountId: z.string().max(60).nullable() }),
      handler: ({ params, body }) => {
        const { fullName } = requireRepo(params.owner, params.name);
        if (body.accountId && !deps.githubAccounts.list().some((a) => a.id === body.accountId)) {
          throw notFound(`unknown GitHub account: ${body.accountId}`);
        }
        deps.store.repos.setGithubAccount(fullName, body.accountId);
        deps.broadcast({ t: 'repos.changed' });
        return { repo: rowToRepo(deps.store.repos.get(fullName)!) };
      },
    }),

    /** Kick a platform pipeline against this repo (no issue/PR payload). */
    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/pipelines/:pipelineId/run',
      access: 'pipelines:run',
      handler: ({ params }) => {
        const { fullName } = requireRepo(params.owner, params.name);
        const pipeline = deps.store.pipelines.get(params.pipelineId);
        if (pipeline && pipeline.type !== 'platform') {
          throw badRequest(`"${pipeline.name}" is a ${pipeline.type} pipeline — run it from a ${pipeline.type}`);
        }
        const run = deps.pipelines.start(params.pipelineId, fullName, 0, 'manual');
        return created({ run });
      },
    }),

    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/automation',
      access: 'automations:manage',
      body: automationSchema,
      handler: ({ params, body }) => {
        const { fullName } = requireRepo(params.owner, params.name);
        if (body.autoTriage !== undefined) deps.store.repos.setAutomation(fullName, 'auto_triage', body.autoTriage);
        if (body.digest !== undefined) deps.store.repos.setAutomation(fullName, 'digest_enabled', body.digest);
        if (body.staleSweep !== undefined) deps.store.repos.setAutomation(fullName, 'stale_enabled', body.staleSweep);
        if (body.prGate !== undefined) deps.store.repos.setAutomation(fullName, 'pr_gate', body.prGate);
        if (body.autoMerge !== undefined) deps.store.repos.setAutomation(fullName, 'auto_merge', body.autoMerge);
        deps.broadcast({ t: 'repos.changed' });
        return { repo: rowToRepo(deps.store.repos.get(fullName)!) };
      },
    }),

    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/webhook',
      access: 'automations:manage',
      handler: ({ params }) => {
        const { fullName } = requireRepo(params.owner, params.name);
        return deps.automations.ensureWebhook(fullName);
      },
    }),

    route({
      method: 'DELETE',
      path: '/api/repos/:owner/:name/webhook',
      access: 'automations:manage',
      handler: ({ params }) => {
        const { fullName } = requireRepo(params.owner, params.name);
        deps.automations.disableWebhook(fullName);
        return { ok: true };
      },
    }),

    /** Read-only info: unlike the POST, never (re-)enables the receiver. */
    route({
      method: 'GET',
      path: '/api/repos/:owner/:name/webhook',
      access: 'automations:manage',
      handler: ({ params }) => {
        const { fullName } = requireRepo(params.owner, params.name);
        return { webhook: deps.automations.webhookInfo(fullName) };
      },
    }),

    /** Instance-wide public webhook delivery over moxxy's proxy relay. */
    route({
      method: 'GET',
      path: '/api/webhooks/tunnel',
      access: 'automations:manage',
      handler: () => ({ enabled: deps.webhookTunnel.enabled(), url: deps.webhookTunnel.url() }),
    }),

    route({
      method: 'PUT',
      path: '/api/webhooks/tunnel',
      access: 'automations:manage',
      body: z.object({ enabled: z.boolean() }),
      handler: async ({ body }) => {
        if (body.enabled) await deps.webhookTunnel.start();
        else await deps.webhookTunnel.stop();
        // Per-repo webhook URLs shown in the UI change with the tunnel.
        deps.broadcast({ t: 'repos.changed' });
        return { enabled: deps.webhookTunnel.enabled(), url: deps.webhookTunnel.url() };
      },
    }),

    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/digest-now',
      access: 'automations:manage',
      handler: async ({ params }) => {
        const { fullName } = requireRepo(params.owner, params.name);
        await deps.automations.runDigest(fullName);
        return { ok: true };
      },
    }),

    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/stale-now',
      access: 'automations:manage',
      handler: ({ params }) => {
        const { fullName } = requireRepo(params.owner, params.name);
        deps.automations.runStaleSweep(fullName);
        return { ok: true };
      },
    }),

    route({
      method: 'GET',
      path: '/api/repos/:owner/:name/issues',
      access: 'issues:read',
      handler: ({ params, query }) => {
        const { fullName } = requireRepo(params.owner, params.name);
        const state = query.get('state');
        return {
          issues: deps.store.issues.list(fullName, state === 'open' || state === 'closed' ? state : undefined),
        };
      },
    }),

    route({
      method: 'GET',
      path: '/api/repos/:owner/:name/prs',
      access: 'prs:read',
      handler: ({ params }) => {
        const { fullName } = requireRepo(params.owner, params.name);
        return { prs: deps.store.prs.list(fullName) };
      },
    }),

    route({
      method: 'GET',
      path: '/api/repos/:owner/:name/triage',
      access: 'issues:read',
      handler: ({ params }) => {
        const { fullName } = requireRepo(params.owner, params.name);
        return { results: deps.store.triage.list(fullName) };
      },
    }),
  ];
}
