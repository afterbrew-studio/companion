import { z } from 'zod';
import { defineRoutes, route, created, badRequest, notFound } from '@companion/core/server';
import type { AuthUser } from '@companion/contracts';
import type { MoxxyStatus, RunRecord } from '../contract/index.js';
import { paths } from '@companion/services';
import { configuredProviderNames, homeStatus, importProvidersFromDailyMoxxy } from '../exec/home.js';
import { upgradeMoxxyCli } from '../exec/cli.js';
import { LOCAL_RUNNER_ID } from './runners-store.js';

// ---------- runs ----------

const createRunSchema = z.object({
  kind: z.enum(['interactive', 'triage', 'fix', 'analysis', 'implement', 'report']).optional(),
  title: z.string().max(200).optional(),
});
const promptSchema = z.object({ prompt: z.string().min(1), model: z.string().optional() });
const askRespondSchema = z.object({
  requestId: z.string(),
  response: z.object({
    mode: z.enum(['allow', 'allow_session', 'allow_always', 'deny']).optional(),
    optionId: z.string().optional(),
    text: z.string().optional(),
  }),
});
const abortSchema = z.object({ turnId: z.string().optional() });
const setModelSchema = z.object({
  model: z.string().min(1).max(256).nullable(),
  provider: z.string().min(1).max(64).optional(),
});

// ---------- runners ----------

const workspaceIds = z.array(z.string()).max(200).optional();
// Per-action model pins: kind → model id. Kinds match RUNNER_PINNABLE_KINDS.
const modelPins = z
  .record(z.enum(['triage', 'analysis', 'fix', 'implement', 'report', 'interactive', 'assistant']), z.string().max(200))
  .optional();

const createRunnerSchema = z.object({
  name: z.string().min(1).max(80),
  endpoint: z.string().url().max(300),
  token: z.string().min(1).max(400),
  scope: z.enum(['shared', 'delegated']).optional(),
  workspaceIds,
  maxRuns: z.number().int().min(1).max(64).optional(),
  modelPins,
});

const updateRunnerSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  endpoint: z.string().url().max(300).optional(),
  token: z.string().min(1).max(400).optional(),
  scope: z.enum(['shared', 'delegated']).optional(),
  workspaceIds,
  maxRuns: z.number().int().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
  modelPins,
});

// ---------- system (status, provider/model settings, skills) ----------

const importSchema = z.object({ sourceHome: z.string().optional() });
const skillSchema = z.object({ content: z.string().max(64_000) });

const RUN_KINDS = ['interactive', 'triage', 'fix', 'analysis', 'implement', 'report', 'assistant'] as const;
const modelPinsSchema = z.object({
  pins: z.record(z.enum(RUN_KINDS), z.string().max(200).nullable()),
});

/**
 * The execution plane's HTTP surface: runs + the run queue, runner machines,
 * moxxy status/provider settings, and the skill library. The fix-flow routes
 * on a run (diff / approve-pr / discard) belong to module-code — they drive
 * `Fixes`, which needs GitHub — and are carved with it.
 */
export default defineRoutes((ctx) => {
  const op = ctx.services.get('operate');
  const settings = ctx.services.get('settings');

  // Run-stream visibility is a security rule with a single owner: the operate
  // service (see OperateService.canSeeRun). Routes here — and module-code's
  // fix-flow routes, and the WS scope resolver — all delegate to it.
  const canSeeRun = (user: AuthUser | null, run: RunRecord): boolean => op.canSeeRun(user, run);
  const requireRunAccess = (user: AuthUser | null, id: string): RunRecord => op.requireRunAccess(user, id);

  return [
    // ---------- runs -------------------------------------------------------------

    route({
      method: 'GET',
      path: '/api/runs',
      access: 'runs:read',
      handler: ({ user }) => ({ runs: op.orchestrator.listRuns().filter((r) => canSeeRun(user, r)) }),
    }),

    route({
      method: 'POST',
      path: '/api/runs',
      access: 'runs:act',
      body: createRunSchema,
      handler: async ({ body, user }) =>
        created({ run: await op.orchestrator.createRun({ ...body, userId: user?.username ?? null }) }),
    }),

    // The scheduler's live state — running count, combined capacity, and the
    // waiting line. Must precede /api/runs/:id so "queue" isn't read as an id.
    route({
      method: 'GET',
      path: '/api/runs/queue',
      access: 'runs:read',
      handler: () => ({ queue: op.orchestrator.queueSnapshot() }),
    }),

    route({
      method: 'POST',
      path: '/api/runs/queue/:id/move',
      access: 'runs:act',
      body: z.object({ direction: z.enum(['up', 'down']) }),
      handler: ({ params, body }) => {
        op.orchestrator.moveQueued(params.id, body.direction);
        return { queue: op.orchestrator.queueSnapshot() };
      },
    }),

    route({
      method: 'DELETE',
      path: '/api/runs/queue/:id',
      access: 'runs:act',
      handler: ({ params }) => {
        op.orchestrator.cancelQueued(params.id);
        return { queue: op.orchestrator.queueSnapshot() };
      },
    }),

    route({
      method: 'GET',
      path: '/api/runs/:id',
      access: 'runs:read',
      handler: ({ params, user }) => {
        const run = requireRunAccess(user, params.id);
        return { run, pendingAsks: op.orchestrator.pendingAsksFor(params.id) };
      },
    }),

    route({
      method: 'GET',
      path: '/api/runs/:id/history',
      access: 'runs:read',
      handler: async ({ params, query, user }) => {
        requireRunAccess(user, params.id);
        const before = query.get('before');
        const limit = Number(query.get('limit') ?? '200');
        return op.orchestrator.loadHistory(
          params.id,
          before === null ? null : Number(before),
          Math.min(Math.max(limit, 1), 500),
        );
      },
    }),

    /** Connected providers + models from the run's live gateway. */
    route({
      method: 'GET',
      path: '/api/runs/:id/models',
      access: 'runs:read',
      handler: ({ params, user }) => {
        requireRunAccess(user, params.id);
        return op.orchestrator.modelCatalog(params.id);
      },
    }),

    /** On-the-fly model switch for this run. */
    route({
      method: 'POST',
      path: '/api/runs/:id/model',
      access: 'runs:act',
      body: setModelSchema,
      handler: async ({ params, body, user }) => {
        requireRunAccess(user, params.id);
        return { run: await op.orchestrator.setRunModel(params.id, body.model, body.provider) };
      },
    }),

    route({
      method: 'POST',
      path: '/api/runs/:id/prompt',
      access: 'runs:act',
      body: promptSchema,
      handler: ({ params, body, user }) => {
        requireRunAccess(user, params.id);
        return op.orchestrator.sendPrompt(params.id, body.prompt, body.model);
      },
    }),

    route({
      method: 'POST',
      path: '/api/runs/:id/abort',
      access: 'runs:act',
      body: abortSchema,
      handler: async ({ params, body, user }) => {
        requireRunAccess(user, params.id);
        await op.orchestrator.abortTurn(params.id, body.turnId);
        return { ok: true };
      },
    }),

    route({
      method: 'POST',
      path: '/api/runs/:id/ask',
      access: 'runs:act',
      body: askRespondSchema,
      handler: async ({ params, body, user }) => {
        requireRunAccess(user, params.id);
        await op.orchestrator.respondAsk(params.id, body.requestId, body.response);
        return { ok: true };
      },
    }),

    route({
      method: 'POST',
      path: '/api/runs/:id/resume',
      access: 'runs:act',
      handler: async ({ params, user }) => {
        requireRunAccess(user, params.id);
        return { run: await op.orchestrator.resumeRun(params.id) };
      },
    }),

    route({
      method: 'POST',
      path: '/api/runs/:id/stop',
      access: 'runs:act',
      handler: async ({ params, user }) => {
        requireRunAccess(user, params.id);
        await op.orchestrator.stopRun(params.id);
        return { ok: true };
      },
    }),

    // ---------- runners: execution machines. Admin-only (instance administration).

    route({
      method: 'GET',
      path: '/api/runners',
      access: 'runners:manage',
      handler: () => ({ runners: op.runners.list() }),
    }),

    route({
      method: 'POST',
      path: '/api/runners',
      access: 'runners:manage',
      body: createRunnerSchema,
      handler: async ({ body }) => {
        if (body.scope === 'delegated' && (body.workspaceIds ?? []).length === 0) {
          throw badRequest('a delegated runner needs at least one workspace');
        }
        return created({ runner: await op.runners.create(body) });
      },
    }),

    route({
      method: 'PATCH',
      path: '/api/runners/:id',
      access: 'runners:manage',
      body: updateRunnerSchema,
      handler: async ({ params, body }) => {
        if (!op.runners.get(params.id)) throw notFound(`runner ${params.id} not found`);
        if (body.scope === 'delegated' && body.workspaceIds && body.workspaceIds.length === 0) {
          throw badRequest('a delegated runner needs at least one workspace');
        }
        return { runner: await op.runners.update(params.id, body) };
      },
    }),

    route({
      method: 'DELETE',
      path: '/api/runners/:id',
      access: 'runners:manage',
      handler: ({ params }) => {
        if (params.id === LOCAL_RUNNER_ID) throw badRequest('the local runner cannot be deleted');
        if (!op.runners.get(params.id)) throw notFound(`runner ${params.id} not found`);
        op.runners.delete(params.id);
        return { ok: true };
      },
    }),

    /** Probe a runner's endpoint now — the "Test connection" action. */
    route({
      method: 'POST',
      path: '/api/runners/:id/probe',
      access: 'runners:manage',
      handler: async ({ params }) => {
        if (!op.runners.get(params.id)) throw notFound(`runner ${params.id} not found`);
        return op.runners.probeNow(params.id);
      },
    }),

    // ---------- moxxy status + provider/model settings ---------------------------

    route({
      // Providers + models as moxxy's gateway reports them (live or last-cached).
      method: 'GET',
      path: '/api/models-catalog',
      access: 'settings:manage',
      handler: () => op.orchestrator.sharedModelCatalog(),
    }),

    route({
      method: 'GET',
      path: '/api/settings/providers',
      access: 'settings:manage',
      handler: () => {
        const parse = (key: string): string[] => {
          try {
            const raw = settings.get(key);
            return raw ? (JSON.parse(raw) as string[]) : [];
          } catch {
            return [];
          }
        };
        // Configured provider names (shared helper — same set runners
        // advertise in health), plus disabled leftovers so they stay visible.
        const names = new Set<string>(configuredProviderNames());
        const disabledProviders = parse('disabledProviders');
        for (const name of disabledProviders) names.add(name);
        return {
          providers: [...names].sort().map((name) => ({ name, enabled: !disabledProviders.includes(name) })),
          disabledModels: parse('disabledModels'),
        };
      },
    }),

    route({
      method: 'PUT',
      path: '/api/settings/providers',
      access: 'settings:manage',
      body: z.object({
        disabledProviders: z.array(z.string().min(1).max(100)).max(100),
        disabledModels: z.array(z.string().min(1).max(200)).max(500),
      }),
      handler: ({ body }) => {
        settings.set('disabledProviders', JSON.stringify(body.disabledProviders));
        settings.set('disabledModels', JSON.stringify(body.disabledModels));
        return { ok: true };
      },
    }),

    route({
      method: 'GET',
      path: '/api/settings/model-pins',
      access: 'settings:manage',
      handler: () => ({
        pins: Object.fromEntries(RUN_KINDS.map((k) => [k, settings.get(`modelPin:${k}`) || null])),
        defaultModel: ctx.config.defaultModel,
      }),
    }),

    route({
      method: 'PUT',
      path: '/api/settings/model-pins',
      access: 'settings:manage',
      body: modelPinsSchema,
      handler: ({ body }) => {
        for (const [kind, model] of Object.entries(body.pins)) {
          settings.set(`modelPin:${kind}`, model?.trim() ?? '');
        }
        return {
          pins: Object.fromEntries(RUN_KINDS.map((k) => [k, settings.get(`modelPin:${k}`) || null])),
        };
      },
    }),

    // Run scheduling (reserved runner slots) moved to module config — the
    // Modules page edits it via PUT /api/modules/operate/config.

    route({
      method: 'GET',
      path: '/api/status',
      access: 'any',
      handler: (): MoxxyStatus => {
        const home = homeStatus();
        const tokens = op.githubTokens();
        return {
          cliPath: op.moxxyCli?.path ?? null,
          cliVersion: op.moxxyCli?.version ?? null,
          compatible: op.moxxyCli?.compatible ?? false,
          homeDir: home.homeDir,
          homeReady: home.homeReady,
          providersImported: home.providersImported,
          // Instance-level health: is GitHub set up at all? Independent of who is
          // viewing (per-user account resolution must not flip the health dot).
          githubConfigured: (tokens.login?.() ?? null) !== null || tokens.tokenFor() !== null,
          githubUser: tokens.login?.() ?? null,
        };
      },
    }),

    route({
      method: 'POST',
      path: '/api/moxxy/import-providers',
      access: 'settings:manage',
      body: importSchema,
      handler: ({ body }) => importProvidersFromDailyMoxxy(body.sourceHome),
    }),

    route({
      // In-place `npm i -g @moxxy/cli@latest`, then re-detect. Works as the
      // initial install too (same command) when no CLI was found at boot.
      method: 'POST',
      path: '/api/moxxy/upgrade-cli',
      access: 'settings:manage',
      handler: async () => {
        const previous = op.moxxyCli?.version ?? null;
        let cli;
        try {
          cli = await upgradeMoxxyCli(paths.moxxyHome(), ctx.config.moxxyCliPath);
        } catch (err) {
          throw badRequest(`npm install failed: ${String(err).slice(0, 400)}`);
        }
        if (!cli) throw badRequest('npm install succeeded but the moxxy CLI still cannot be detected on PATH');
        op.setMoxxyCli(cli);
        ctx.log.info('moxxy CLI upgraded', { previous, version: cli.version, compatible: cli.compatible });
        return { previous, version: cli.version, compatible: cli.compatible };
      },
    }),

    // ---------- skills ------------------------------------------------------------

    route({
      method: 'GET',
      path: '/api/skills',
      access: 'skills:manage',
      handler: () => ({ skills: op.skills.list() }),
    }),

    route({
      method: 'GET',
      path: '/api/skills/:name',
      access: 'skills:manage',
      handler: ({ params }) => {
        const skill = op.skills.get(params.name);
        if (!skill) throw notFound(`skill ${params.name} not found`);
        return { skill };
      },
    }),

    route({
      method: 'PUT',
      path: '/api/skills/:name',
      access: 'skills:manage',
      body: skillSchema,
      handler: ({ params, body }) => ({ skill: op.skills.save(params.name, body.content) }),
    }),

    route({
      method: 'DELETE',
      path: '/api/skills/:name',
      access: 'skills:manage',
      handler: ({ params }) => {
        op.skills.remove(params.name);
        return { ok: true };
      },
    }),
  ];
});
