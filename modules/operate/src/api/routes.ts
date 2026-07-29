import { z } from 'zod';
import { defineRoutes, route, created, badRequest, notFound } from '@moxxy/companion-core/server';
import type { AuthUser } from '@moxxy/companion-contracts';
import type {
  MoxxyStatus,
  RunnerPolicyOptions,
  RunRecord,
  RunTaskDescriptor,
  RunTaskGroup,
  TaskModelPin,
  TaskModelSnapshot,
} from '../contract/index.js';
import { taskModuleId } from '../contract/index.js';
import { paths } from '@moxxy/companion-services';
import { adoptDailyMoxxyHome, homeStatus, importProvidersFromDailyMoxxy } from '../exec/home.js';
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
// What a machine may be used for. Unknown module/task ids are accepted — the
// owning module may be disabled right now, and the decision must survive that.
const taskPolicySchema = z.object({
  mode: z.enum(['allow', 'deny']),
  modules: z.array(z.string().min(1).max(64)).max(100),
  tasks: z.array(z.string().min(1).max(64)).max(200),
});
const repoIds = z.array(z.string().min(1).max(200)).max(500).optional();
const allowedRoles = z.array(z.string().min(1).max(64)).max(50).optional();

const createRunnerSchema = z.object({
  name: z.string().min(1).max(80),
  endpoint: z.string().url().max(300),
  token: z.string().min(1).max(400),
  shared: z.boolean().optional(),
  scope: z.enum(['shared', 'delegated']).optional(),
  workspaceIds,
  maxRuns: z.number().int().min(1).max(64).optional(),
  taskPolicy: taskPolicySchema.optional(),
});

// One machine's provider policy. Full replacement; unknown names are allowed,
// because a machine may list them again after a credential or catalog change
// and the switch-off must survive until then.
const providerPolicySchema = z.object({
  disabledProviders: z.array(z.string().min(1).max(100)).max(100),
  disabledModels: z.array(z.string().min(1).max(200)).max(500),
});

// Adding a provider to a machine. The slug is NOT checked against a copy of
// moxxy's list: moxxy owns it and refuses an unknown one naming the valid ones,
// so a copy here would only rot. `key` is bounded but otherwise opaque: it is
// forwarded to the machine and never stored.
const provisionProviderSchema = z.object({
  provider: z.string().min(1).max(64),
  key: z.string().min(1).max(4_000).optional(),
  model: z.string().min(1).max(200).optional(),
});

const updateRunnerSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  endpoint: z.string().url().max(300).optional(),
  token: z.string().min(1).max(400).optional(),
  scope: z.enum(['shared', 'delegated']).optional(),
  workspaceIds,
  maxRuns: z.number().int().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
  taskPolicy: taskPolicySchema.optional(),
  repoScope: z.enum(['all', 'selected']).optional(),
  repoIds,
  allowedRoles,
});

// ---------- system (status, provider/model settings, skills) ----------

const importSchema = z.object({ sourceHome: z.string().optional() });
const skillSchema = z.object({ content: z.string().max(64_000) });

// A patch over the task pins: task id → model, null clears. Omitted tasks keep
// their pin, so one row's edit never rewrites the rest of the page.
const taskModelsSchema = z.object({
  pins: z
    .record(z.string().min(1).max(64), z.string().max(200).nullable())
    .refine((pins) => Object.keys(pins).length <= 100, 'too many tasks in one write'),
});

/**
 * The execution plane's HTTP surface: runs + the run queue, runner machines,
 * moxxy status/provider settings, and the skill library. The fix-flow routes
 * on a run (diff / approve-pr / discard) belong to module-code — they drive
 * `Fixes`, which needs GitHub — and are carved with it.
 */
export default defineRoutes((ctx) => {
  const op = ctx.services.get('operate');
  const workspace = ctx.services.get('workspace');

  // Run-stream visibility is a security rule with a single owner: the operate
  // service (see OperateService.canSeeRun). Routes here — and module-code's
  // fix-flow routes, and the WS scope resolver — all delegate to it.
  const canSeeRun = (user: AuthUser | null, run: RunRecord): boolean => op.canSeeRun(user, run);
  const requireRunAccess = (user: AuthUser | null, id: string): RunRecord => op.requireRunAccess(user, id);
  const requireQueueEntryAccess = (user: AuthUser | null, id: string): void => {
    if (!op.queueSnapshot(user).entries.some((entry) => entry.id === id)) {
      throw notFound(`queued run ${id} not found`);
    }
  };

  /**
   * The Task models page payload. Tasks group by the module that registered
   * them, read off the id prefix (`<moduleId>.<name>`) and titled from the
   * kernel's catalogue, so there is no second registry to keep in step.
   */
  const taskModelSnapshot = (): TaskModelSnapshot => {
    const titles = new Map<string, string>(ctx.modules.list().map((m) => [m.id, m.title]));
    return {
      tasks: op.runTaskDescriptors().map((task): TaskModelPin => {
        const moduleId = taskModuleId(task.id);
        return {
          task,
          moduleId,
          moduleTitle: titles.get(moduleId) ?? moduleId,
          model: op.orchestrator.taskModelPin(task.id),
        };
      }),
      models: op.runners.servableModels(),
      defaultModel: ctx.config.defaultModel,
    };
  };

  const requireAccessibleWorkspaceIds = (user: AuthUser | null, ids: readonly string[]): void => {
    if (!user || ids.some((id) => !workspace.canAccessWorkspace(user, id))) {
      throw notFound('workspace not found');
    }
  };

  const requireAccessibleRepos = (user: AuthUser | null, ids: readonly string[]): void => {
    if (!user || ids.some((id) => !workspace.canAccessRepo(user, id))) throw notFound('repository not found');
  };

  /**
   * The registered work grouped by the module that owns it, read off the task
   * id prefix and titled from the kernel's catalogue — no second registry to
   * keep in step. Modules with no registered task never appear, so the policy
   * tree only offers entries that mean something.
   */
  const taskGroups = (): RunTaskGroup[] => {
    const titles = new Map<string, string>(ctx.modules.list().map((m) => [m.id, m.title]));
    const groups = new Map<string, RunTaskDescriptor[]>();
    for (const task of op.runTaskDescriptors()) {
      const moduleId = taskModuleId(task.id);
      const bucket = groups.get(moduleId);
      if (bucket) bucket.push(task);
      else groups.set(moduleId, [task]);
    }
    return [...groups.entries()]
      .map(([moduleId, tasks]) => ({ moduleId, moduleTitle: titles.get(moduleId) ?? moduleId, tasks }))
      .sort((a, b) => a.moduleTitle.localeCompare(b.moduleTitle));
  };

  // Personal runners stay private to their owner. Admins additionally manage
  // shared instance runners, without inheriting other users' machines.
  const requireManageableRunner = (user: AuthUser | null, id: string): void => {
    const runner = op.runners.get(id);
    if (!runner) throw notFound(`runner ${id} not found`);
    const canManageShared = !!user && runner.ownerId === null && ctx.rbac.has(user.role, 'runners:manage');
    if (!user || (runner.ownerId !== user.username && !canManageShared)) throw notFound(`runner ${id} not found`);
  };

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
      // `task` is server-assigned (never client input) so filters can't be dodged.
      handler: async ({ body, user }) =>
        created({
          run: await op.orchestrator.createRun({
            ...body,
            task: (body.kind ?? 'interactive') === 'interactive' ? 'operate.chat' : null,
            userId: user?.username ?? null,
          }),
        }),
    }),

    // The scheduler's live state — running count, combined capacity, and the
    // waiting line. Must precede /api/runs/:id so "queue" isn't read as an id.
    route({
      method: 'GET',
      path: '/api/runs/queue',
      access: 'runs:read',
      handler: ({ user }) => ({ queue: op.queueSnapshot(user) }),
    }),

    // Token spend for the dashboard cost analytics — daily buckets + per-model
    // totals, aggregated in SQL over the last 14 days. Must precede
    // /api/runs/:id so "usage" isn't read as an id.
    route({
      method: 'GET',
      path: '/api/runs/usage',
      access: 'runs:read',
      handler: ({ user }) => op.tokenUsage(user),
    }),

    // The spend position anyone launching runs needs, including their own slice:
    // a refusal has to be explainable to the person who hit it.
    route({
      method: 'GET',
      path: '/api/budget',
      access: 'runs:read',
      handler: ({ user }) => op.budgets.status(user?.username ?? null),
    }),

    // Attribution names who and what spent the money, so it sits behind
    // instance administration rather than runs:read.
    route({
      method: 'GET',
      path: '/api/budget/spend',
      access: 'settings:manage',
      handler: () => op.budgets.breakdown(),
    }),

    route({
      method: 'POST',
      path: '/api/runs/queue/:id/move',
      access: 'runs:act',
      body: z.object({ direction: z.enum(['up', 'down']) }),
      handler: ({ params, body, user }) => {
        requireQueueEntryAccess(user, params.id);
        op.orchestrator.moveQueued(params.id, body.direction);
        return { queue: op.queueSnapshot(user) };
      },
    }),

    route({
      method: 'DELETE',
      path: '/api/runs/queue/:id',
      access: 'runs:act',
      handler: ({ params, user }) => {
        requireQueueEntryAccess(user, params.id);
        op.orchestrator.cancelQueued(params.id);
        return { queue: op.queueSnapshot(user) };
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

    // ---------- runners: execution machines ---------------------------------------
    // Admins manage shared instance runners; everyone manages their own machines
    // (runners:connect). Private machines never become visible through role.

    route({
      // Shared machines are visible to every user; private machines stay
      // owner-only, including from admins. Ships task descriptors alongside
      // for the per-runner task filter.
      method: 'GET',
      path: '/api/runners',
      access: 'runners:connect',
      handler: ({ user }) => ({
        runners: op.runners.list().filter((runner) => runner.ownerId === null || runner.ownerId === user?.username),
        tasks: op.runTaskDescriptors(),
      }),
    }),

    route({
      // What a machine's policy and placement can be written against. Its own
      // route because it turns over with the module set and the repo list, not
      // with health — /api/runners is re-read on every runners.changed, which
      // fires whenever a health probe moves. Must precede /api/runners/:id.
      method: 'GET',
      path: '/api/runners/options',
      access: 'runners:connect',
      handler: ({ user }): RunnerPolicyOptions => ({
        groups: taskGroups(),
        repos: op.runners.repoOptions().filter((repo) => !!user && workspace.canAccessRepo(user, repo.fullName)),
        roles: [...ctx.rbac.roles()],
      }),
    }),

    route({
      // Capacity is safe instance health: no run titles, repos, or owner ids.
      // It is viewer-specific because their private runners extend the pool.
      method: 'GET',
      path: '/api/runners/capacity',
      access: 'runners:connect',
      handler: ({ user }) => op.runners.capacitySnapshot(user?.username ?? null),
    }),

    route({
      method: 'POST',
      path: '/api/runners',
      access: 'runners:connect',
      body: createRunnerSchema,
      handler: async ({ body, user }) => {
        if (body.scope === 'delegated' && (body.workspaceIds ?? []).length === 0) {
          throw badRequest('a delegated runner needs at least one workspace');
        }
        if (body.scope === 'delegated') requireAccessibleWorkspaceIds(user, body.workspaceIds ?? []);
        // A shared instance runner is admin-only; everyone else's is private.
        const ownerId = ctx.rbac.has(user!.role, 'runners:manage') && body.shared ? null : user!.username;
        return created({ runner: await op.runners.create(body, ownerId) });
      },
    }),

    route({
      method: 'PATCH',
      path: '/api/runners/:id',
      access: 'runners:connect',
      body: updateRunnerSchema,
      handler: async ({ params, body, user }) => {
        requireManageableRunner(user, params.id);
        const runner = op.runners.get(params.id)!;
        const nextScope = body.scope ?? runner.scope;
        const nextWorkspaceIds = body.workspaceIds ?? runner.workspaceIds;
        if (nextScope === 'delegated' && nextWorkspaceIds.length === 0) {
          throw badRequest('a delegated runner needs at least one workspace');
        }
        if (nextScope === 'delegated') requireAccessibleWorkspaceIds(user, nextWorkspaceIds);
        const nextRepoScope = body.repoScope ?? runner.repoScope;
        const nextRepoIds = body.repoIds ?? runner.repoIds;
        if (nextRepoScope === 'selected' && nextRepoIds.length === 0) {
          throw badRequest('a repository-scoped machine needs at least one repository');
        }
        if (nextRepoScope === 'selected') requireAccessibleRepos(user, nextRepoIds);
        // A role nobody holds would fence the machine off silently, so an
        // unknown id is refused at the edge rather than stored and ignored.
        for (const role of body.allowedRoles ?? []) {
          if (!ctx.rbac.hasRole(role)) throw badRequest(`unknown role ${role}`);
        }
        // A private machine has no roles control (ownership already answers the
        // question), so one set here could lock its owner out with no way back.
        if ((body.allowedRoles ?? []).length > 0 && runner.ownerId !== null) {
          throw badRequest('role restrictions apply to shared machines; this one is already limited to its owner');
        }
        return { runner: await op.runners.update(params.id, body) };
      },
    }),

    route({
      method: 'DELETE',
      path: '/api/runners/:id',
      access: 'runners:connect',
      handler: ({ params, user }) => {
        if (params.id === LOCAL_RUNNER_ID) throw badRequest('the local runner cannot be deleted');
        requireManageableRunner(user, params.id);
        op.runners.delete(params.id);
        return { ok: true };
      },
    }),

    route({
      // Which of THIS machine's providers/models agents may use. Catalogs are
      // per machine, so the policy over them is too: the same provider can be
      // credential-ready here and absent next door. Gated like every other edit
      // to a machine (own it, or hold runners:manage over the shared pool),
      // which is why it lives under /api/runners rather than /api/providers.
      method: 'PUT',
      path: '/api/runners/:id/providers',
      access: 'runners:connect',
      body: providerPolicySchema,
      handler: ({ params, body, user }) => {
        requireManageableRunner(user, params.id);
        op.runners.setProviderPolicy(params.id, body);
        return op.runners.catalogSnapshot(ctx.config.defaultModel, user?.username ?? null);
      },
    }),

    route({
      // Give THIS machine a model provider, by running `moxxy provision` there.
      // Sibling of the PUT above and deliberately so: that one decides which of
      // the providers a machine already has agents may use, this one gives it
      // another. Same gate (own the machine, or hold runners:manage over the
      // shared pool) because both change what work can land here.
      //
      // The key is forwarded to the machine and never persisted, logged or
      // returned; the reply is the re-probe, so the caller sees the machine's
      // own account of what it now has.
      method: 'POST',
      path: '/api/runners/:id/providers',
      access: 'runners:connect',
      body: provisionProviderSchema,
      handler: async ({ params, body, user }) => {
        requireManageableRunner(user, params.id);
        try {
          return await op.runners.provisionProvider(params.id, body);
        } catch (err) {
          throw badRequest(String(err instanceof Error ? err.message : err).slice(0, 500));
        }
      },
    }),

    /** Probe a runner's endpoint now — the "Test connection" action. */
    route({
      method: 'POST',
      path: '/api/runners/:id/probe',
      access: 'runners:connect',
      handler: async ({ params, user }) => {
        requireManageableRunner(user, params.id);
        return op.runners.probeNow(params.id);
      },
    }),

    route({
      // Update the moxxy CLI on a runner's machine from the Runners page. The
      // local runner reuses the same in-place upgrade the Providers page does;
      // remote runners go through the agent's /agent/update-moxxy endpoint.
      method: 'POST',
      path: '/api/runners/:id/update-moxxy',
      access: 'runners:connect',
      handler: async ({ params, user }) => {
        requireManageableRunner(user, params.id);
        try {
          if (params.id === LOCAL_RUNNER_ID) {
            const previous = op.moxxyCli?.version ?? null;
            const cli = await upgradeMoxxyCli(paths.moxxyHome(), ctx.config.moxxyCliPath);
            if (!cli) throw new Error('npm install succeeded but the moxxy CLI still cannot be detected on PATH');
            op.setMoxxyCli(cli);
            ctx.broadcast({ t: 'runners.changed' });
            return { previous, version: cli.version, compatible: cli.compatible };
          }
          return await op.runners.updateMoxxy(params.id);
        } catch (err) {
          throw badRequest(String(err instanceof Error ? err.message : err).slice(0, 500));
        }
      },
    }),

    // ---------- moxxy status + provider/model settings ---------------------------

    route({
      // One group per machine plus the merged effective set. A pure read that
      // answers from cache and nudges a background top-up; whatever it finds
      // reaches the page over `runners.changed`.
      method: 'GET',
      path: '/api/providers',
      access: 'settings:manage',
      handler: ({ user }) => {
        // Self-limiting: unforced refreshes are no-ops while catalogs are
        // within their TTL, so opening the page costs nothing on the machines.
        void op.runners.refreshAllCatalogs(false, user?.username ?? null);
        return op.runners.catalogSnapshot(ctx.config.defaultModel, user?.username ?? null);
      },
    }),

    route({
      // Re-run detection, then force a re-read from every online machine (the
      // page's only button). Adoption comes first so a moxxy home configured
      // after this daemon booted is picked up without a restart.
      method: 'POST',
      path: '/api/providers/refresh',
      access: 'settings:manage',
      handler: async ({ user }) => {
        if (adoptDailyMoxxyHome()) ctx.broadcast({ t: 'runners.changed' });
        await op.runners.refreshAllCatalogs(true, user?.username ?? null);
        return op.runners.catalogSnapshot(ctx.config.defaultModel, user?.username ?? null);
      },
    }),

    route({
      // Which model each unit of agent work rides. Instance-wide and keyed by
      // the task descriptors modules register, so the catalogue costs nothing
      // to keep current and a machine never carries model policy.
      method: 'GET',
      path: '/api/settings/task-models',
      access: 'settings:manage',
      handler: () => taskModelSnapshot(),
    }),

    route({
      method: 'PUT',
      path: '/api/settings/task-models',
      access: 'settings:manage',
      body: taskModelsSchema,
      handler: ({ body }) => {
        // Registered ids only, so the settings table can't accumulate pins for
        // work that will never run. A module disabled since boot keeps its
        // registration (and so stays editable) until the daemon restarts;
        // after that its stored pin survives but is neither shown nor writable.
        const known = new Set(op.runTaskDescriptors().map((task) => task.id));
        for (const task of Object.keys(body.pins)) {
          if (!known.has(task)) throw badRequest(`unknown task ${task}`);
        }
        for (const [task, model] of Object.entries(body.pins)) {
          op.orchestrator.setTaskModelPin(task, model);
        }
        // Instance-wide policy: every other admin's page is now stale.
        ctx.broadcast({ t: 'task-models.changed' });
        return taskModelSnapshot();
      },
    }),

    // Run scheduling (reserved runner slots) moved to module config — the
    // Modules page edits it via PUT /api/modules/operate/config.

    route({
      method: 'GET',
      path: '/api/status',
      access: 'any',
      handler: async (): Promise<MoxxyStatus> => {
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
          githubConfigured:
            tokens.hasAccounts?.() ??
            ((tokens.login?.() ?? null) !== null || (await tokens.tokenFor()) !== null),
          githubUser: tokens.login?.() ?? null,
        };
      },
    }),

    route({
      method: 'POST',
      path: '/api/moxxy/import-providers',
      access: 'settings:manage',
      body: importSchema,
      handler: ({ body }) => {
        const result = importProvidersFromDailyMoxxy(body.sourceHome);
        // New credentials mean new models: re-read this machine in the
        // background so the page fills in without a second click.
        void op.runners.refreshCatalog(LOCAL_RUNNER_ID, true);
        return result;
      },
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
