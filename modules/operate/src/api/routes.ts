import { z } from 'zod';
import { defineRoutes, route, created, badRequest, notFound } from '@moxxy/companion-core/server';
import type { AuthUser } from '@moxxy/companion-contracts';
import type {
  OperateStatus,
  RunnerPolicyOptions,
  RunRecord,
  RunLane,
  RunTaskDescriptor,
  RunTaskGroup,
  TaskModelPin,
  TaskModelSnapshot,
} from '../contract/index.js';
import { taskModuleId } from '../contract/index.js';
import { HARNESSES } from './harnesses.js';
import { LOCAL_RUNNER_ID } from './runners-store.js';

// ---------- runs ----------

const createRunSchema = z.object({
  kind: z.enum(['interactive', 'triage', 'fix', 'analysis', 'implement', 'report']).optional(),
  title: z.string().max(200).optional(),
});
const promptSchema = z.object({ prompt: z.string().min(1), model: z.string().optional() });
const laneSchema = z.object({
  runnerId: z.string().min(1).nullable(),
  harness: z.string().min(1).nullable(),
});
const laneModelSchema = z.object({
  lane: laneSchema,
  /** Omitted task sets the lane default; present pins that task. */
  task: z.string().min(1).max(64).optional(),
  model: z.string().max(200).nullable(),
});
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

function pageInteger(raw: string | null, fallback: number, min: number, max: number, name: string): number {
  if (raw === null || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw badRequest(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw badRequest(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

function queryText(raw: string | null, max: number, name: string): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (value.length > max) throw badRequest(`${name} must be at most ${max} characters`);
  return value;
}

function queryChoice<const T extends string>(raw: string | null, values: readonly T[], name: string): T | undefined {
  if (raw === null || raw === '') return undefined;
  if (!values.includes(raw as T)) throw badRequest(`${name} has an unsupported value`);
  return raw as T;
}

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
  harnesses: z.array(z.string().min(1).max(60)).min(1).max(8).optional(),
});

// ---------- system (status, provider/model settings, skills) ----------

const skillSchema = z.object({ content: z.string().max(64_000) });

// A patch over the task pins: task id → model, null clears. Omitted tasks keep
// their pin, so one row's edit never rewrites the rest of the page.
const taskModelsSchema = z.object({
  pins: z
    .record(z.string().min(1).max(64), z.string().max(200).nullable())
    .refine((pins) => Object.keys(pins).length <= 100, 'too many tasks in one write'),
  /** Absent writes the instance-wide layer; present writes that lane's pins. */
  lane: laneSchema.optional(),
  /** Lane only: its fallback for tasks with no pin of their own. */
  defaultModel: z.string().max(200).nullable().optional(),
});

/**
 * The execution plane's HTTP surface: runs + the run queue, runner machines,
 * execution status, provider settings, and the skill library. The fix-flow routes
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
  const taskModelSnapshot = (lane?: RunLane): TaskModelSnapshot => {
    const titles = new Map<string, string>(ctx.modules.list().map((m) => [m.id, m.title]));
    const tasks = op.runTaskDescriptors();
    const laneModels = lane ? op.orchestrator.laneModels(lane, tasks.map((t) => t.id)) : null;
    const lastRuns = op.runsStore.lastByTask();
    // Every machine × runtime a lane can be configured for. Personal machines
    // belonging to somebody else are left out for the same reason they are not
    // offered in the picker: nobody here can place work there.
    const lanes = op.runners
      .list()
      .filter((runner) => runner.enabled && runner.ownerId === null)
      .flatMap((runner) =>
        runner.harnesses.map((harness) => ({
          runnerId: runner.id,
          harness: harness.id,
          label: `${runner.name} · ${harness.label}`,
        })),
      );
    return {
      tasks: tasks.map((task): TaskModelPin => {
        const moduleId = taskModuleId(task.id);
        return {
          task,
          moduleId,
          moduleTitle: titles.get(moduleId) ?? moduleId,
          model: op.orchestrator.taskModelPin(task.id),
          ...(laneModels ? { laneModel: laneModels.pins[task.id] ?? null } : {}),
          lastRun: lastRuns.get(task.id) ?? null,
        };
      }),
      // Scoped to the lane when one is being configured: a runtime that cannot
      // serve a model must not offer it, or the pin is dropped at dispatch and
      // nobody is told why.
      models: lane ? op.runners.modelsForLane(lane.runnerId, lane.harness) : op.runners.servableModels(),
      ...(lane ? { lane, laneDefaultModel: laneModels?.defaultModel ?? null } : {}),
      lanes,
    };
  };

  /**
   * The lane a person's own actions run in, with everything the picker needs to
   * render it: the machines they can reach, the runtimes each of those runs,
   * and the models set on the chosen lane.
   */
  const laneSnapshot = (user: AuthUser | null) => {
    const lane = user ? op.orchestrator.userLane(user.username) : { runnerId: null, harness: null };
    return {
      lane,
      // Personal machines belonging to somebody else are not choices this
      // person can make, so they are not offered as ones.
      machines: op.runners
        .list()
        .filter((runner) => runner.enabled && (runner.ownerId === null || runner.ownerId === user?.username))
        .map((runner) => ({
          id: runner.id,
          name: runner.name,
          status: runner.health.status,
          harnesses: runner.harnesses.map((h) => ({ id: h.id, label: h.label })),
        })),
      // Which of those the Task models page can actually represent. It lists
      // shared machines only, so a link from a personal one would arrive at a
      // lane its "Applies to" select has no option for.
      lanesConfigurable: op.runners
        .list()
        .filter((runner) => runner.enabled && runner.ownerId === null)
        .map((runner) => runner.id),
      models: op.orchestrator.laneModels(lane, op.runTaskDescriptors().map((t) => t.id)),
      // Scoped to the chosen lane, so a page asking "what will this run on"
      // gets the models that lane can actually serve, not the instance's union.
      servable:
        lane.runnerId !== null
          ? op.runners.modelsForLane(lane.runnerId, lane.harness)
          : op.runners.servableModels(),
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
    const canManageShared = !!user && runner.ownerId === null && ctx.rbac.allows(user, 'runners:manage');
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
      method: 'GET',
      path: '/api/runs/page',
      access: 'runs:read',
      handler: ({ query, user }) => {
        if (!user) return { runs: [], total: 0 };
        const workspaceId = queryText(query.get('workspace'), 100, 'workspace');
        if (workspaceId) workspace.requireAccessible(user, workspaceId);
        return op.orchestrator.listRunsPage({
          userId: user.username,
          repoNames: workspaceId ? workspace.repoNames(workspaceId) : undefined,
          q: queryText(query.get('q'), 200, 'q'),
          repo: queryText(query.get('repo'), 200, 'repo'),
          kind: queryChoice(
            query.get('kind'),
            ['interactive', 'assistant', 'triage', 'fix', 'analysis', 'implement', 'report'] as const,
            'kind',
          ),
          status: queryChoice(
            query.get('status'),
            ['active', 'review', 'running', 'completed', 'failed', 'stopped'] as const,
            'status',
          ),
          limit: pageInteger(query.get('limit'), 50, 1, 100, 'limit'),
          offset: pageInteger(query.get('offset'), 0, 0, 1_000_000, 'offset'),
        });
      },
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

    // The effective agent policy. Readable by anyone who launches runs: being
    // refused a push is much easier to act on when you can see the rule.
    route({
      method: 'GET',
      path: '/api/agent-policy',
      access: 'runs:read',
      handler: () => op.agentPolicy.snapshot(),
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

    /** Which machine and runtime this person's own actions run on. */
    route({
      method: 'GET',
      path: '/api/me/lane',
      access: 'runs:read',
      handler: ({ user }) => laneSnapshot(user),
    }),

    route({
      method: 'PUT',
      path: '/api/me/lane',
      access: 'runs:act',
      body: laneSchema,
      handler: ({ body, user }) => {
        op.orchestrator.setUserLane(user!.username, body);
        return laneSnapshot(user);
      },
    }),

    /** A model on a lane: the lane's default, or its pin for one task. */
    route({
      method: 'PUT',
      path: '/api/me/lane/model',
      access: 'runs:act',
      body: laneModelSchema,
      handler: ({ body, user }) => {
        if (body.task === undefined) op.orchestrator.setLaneDefaultModel(body.lane, body.model);
        else op.orchestrator.setLaneTaskPin(body.lane, body.task, body.model);
        return laneSnapshot(user);
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
      // What this machine could be set to run, detected on it rather than
      // listed from a catalogue: harnesses it has not installed are absent from
      // the answer, not marked unavailable. Its own route because detection
      // shells out, so it must not ride the runners payload that every
      // `runners.changed` re-reads. Must precede /api/runners/:id.
      method: 'GET',
      path: '/api/runners/harnesses/:id',
      access: 'runners:connect',
      handler: ({ params, user }) => {
        requireManageableRunner(user, params.id);
        return op.runners.harnessOptions(params.id);
      },
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
        const ownerId = ctx.rbac.allows(user!, 'runners:manage') && body.shared ? null : user!.username;
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
        // A machine set to a runtime this build cannot run would accept
        // placements nothing could execute, so an unknown id is refused here
        // rather than silently dropped when the set is read back.
        for (const id of body.harnesses ?? []) {
          if (!HARNESSES.some((h) => h.id === id)) throw badRequest(`unknown agent runtime ${id}`);
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
        return op.runners.catalogSnapshot(user?.username ?? null);
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

    // ---------- execution status + provider/model settings -----------------------

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
        return op.runners.catalogSnapshot(user?.username ?? null);
      },
    }),

    route({
      // Force a capability re-read from every online machine. Runtime-specific
      // config adoption happens inside its adapter at boot; this route knows
      // only that machines report catalogs.
      method: 'POST',
      path: '/api/providers/refresh',
      access: 'settings:manage',
      handler: async ({ user }) => {
        await op.runners.refreshAllCatalogs(true, user?.username ?? null);
        return op.runners.catalogSnapshot(user?.username ?? null);
      },
    }),

    route({
      // Which model each unit of agent work rides. Instance-wide and keyed by
      // the task descriptors modules register, so the catalogue costs nothing
      // to keep current and a machine never carries model policy.
      method: 'GET',
      path: '/api/settings/task-models',
      access: 'settings:manage',
      handler: ({ query }) => {
        const runnerId = query.get('runner');
        const harness = query.get('harness');
        return taskModelSnapshot(runnerId && harness ? { runnerId, harness } : undefined);
      },
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
          if (body.lane) op.orchestrator.setLaneTaskPin(body.lane, task, model);
          else op.orchestrator.setTaskModelPin(task, model);
        }
        if (body.lane && body.defaultModel !== undefined) {
          op.orchestrator.setLaneDefaultModel(body.lane, body.defaultModel);
        }
        // Instance-wide policy: every other admin's page is now stale. A lane's
        // own pins are broadcast too, so a second tab editing the same lane
        // does not sit on a copy that is already wrong.
        ctx.broadcast({ t: 'task-models.changed' });
        return taskModelSnapshot(body.lane ?? undefined);
      },
    }),

    // Run scheduling (reserved runner slots) moved to module config — the
    // Modules page edits it via PUT /api/modules/operate/config.

    route({
      method: 'GET',
      path: '/api/status',
      access: 'any',
      allowScopedToken: true,
      handler: async (): Promise<OperateStatus> => {
        const runners = op.runners.list().filter((runner) => runner.enabled);
        const ready = runners.find(
          (runner) =>
            runner.health.agentOutdated !== true &&
            runner.health.runtimes[0]?.state === 'ready',
        );
        const tokens = op.githubTokens();
        return {
          executionReady: ready !== undefined,
          executionDetail:
            ready !== undefined
              ? null
              : runners.find((runner) => runner.health.detail)?.health.detail ??
                (runners.length === 0 ? 'No execution machine is enabled' : 'No selected runtime is ready'),
          // Instance-level health: is GitHub set up at all? Independent of who is
          // viewing (per-user account resolution must not flip the health dot).
          githubConfigured:
            tokens.hasAccounts?.() ??
            ((tokens.login?.() ?? null) !== null || (await tokens.tokenFor()) !== null),
          githubUser: tokens.login?.() ?? null,
        };
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
