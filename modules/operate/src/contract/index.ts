// Brings module-core's + module-workspace's augmentations (operate dependsOn both).
import '@companion/module-core/contract';
import '@companion/module-workspace/contract';
import type { AskRequest, HarnessCapabilities, MoxxyEvent } from '@moxxy/companion-types';
import type { OperateService } from '../api/operate-service.js';

export { estimateUsd, formatUsd, priceFor, type ModelPricing } from './model-pricing.js';

/**
 * module-operate contract slice — the execution plane: agent runs + the run
 * queue, runner machines (local/remote), the moxxy gateway surface, and skills.
 */

declare module '@moxxy/companion-contracts' {
  interface PermissionRegistry {
    'runs:read': true;
    'runs:act': true;
    'runners:manage': true;
    /** Connect and manage runner machines you own (bring-your-own-subscription). */
    'runners:connect': true;
    'skills:manage': true;
  }
  interface ServerMessageRegistry {
    /** Live transcript event of a run the viewer may see. */
    event: { readonly runId: string; readonly event: MoxxyEvent };
    turn: { readonly runId: string; readonly phase: 'started' | 'complete'; readonly turnId?: string };
    ask: { readonly runId: string; readonly ask: AskRequest };
    askResolved: { readonly runId: string; readonly requestId: string };
    'run.changed': { readonly run: RunRecord };
    'runs.changed': Record<never, never>;
    'queue.changed': Record<never, never>;
    'runners.changed': Record<never, never>;
    /** Instance model policy moved: which model each registered task rides. */
    'task-models.changed': Record<never, never>;
  }
  interface ServiceMap {
    /** The execution plane: orchestrator + runners + checkouts + the moxxy CLI. */
    operate: OperateService;
  }
  interface BusEvents {
    /** Server-internal run lifecycle signal (modules react in onEnable, e.g. plan). */
    'run.changed': RunRecord;
  }
}

/**
 * Cross-module seam: where network git credentials come from. GitHub accounts
 * are owned by module-code (which depends on operate), so code PLUGS its
 * resolver in via `services.get('operate').setGithubTokenSource(...)` at
 * onEnable — inversion of control; operate never imports code. The default is
 * fail-closed until code registers its personal-account resolver.
 */
export interface GithubTokenSource {
  /**
   * Token for network git operations, resolved per repo and optional owning
   * user; null = none configured. May be async — an access-verified resolver
   * probes GitHub to pick an account that can actually reach the repo.
   *
   * `access` states what the operation needs: reading (clone/fetch) accepts any
   * account that can see the repo, 'write' (push) demands one that may push, so
   * a read-only account is never handed to git only to 403 mid-push.
   */
  tokenFor(repo?: string, username?: string | null, access?: GitAccess): string | null | Promise<string | null>;
  /** Login of the default posting account, when known (feeds /api/status). */
  login?(): string | null;
  /**
   * Does the instance have ANY GitHub account at all?
   *
   * Separate from `tokenFor` on purpose. Resolution is scoped: an account
   * restricted to selected workspaces answers nothing without a workspace in
   * hand, and a health indicator asking "is GitHub set up" must not go red
   * because the viewer happens to be nowhere in particular. Absent means fall
   * back to resolution, which is right for a source that has no notion of a
   * catalogue.
   */
  hasAccounts?(): boolean;
}

/** Reach a git network operation needs from the credential it is given. */
export type GitAccess = 'read' | 'write';

/** The resolver shape the execution plane passes around internally. */
export type GitCredentialResolver = (
  repo: string,
  username?: string | null,
  access?: GitAccess,
) => Promise<string | null> | string | null;

// ---------- harnesses (the agent runtime work executes through) ----------

/**
 * One agent runtime a machine can run work through, carrying its own answer to
 * what it can do. The capabilities travel with the id rather than being looked
 * up client-side, because they belong to the implementation: a build that drops
 * a harness, or a module that adds one, must not need a second table updated in
 * step. The id is open for the same reason.
 */
export interface HarnessDescriptor {
  readonly id: string;
  /** How the harness names itself in the UI ('Moxxy', 'Claude Code'). */
  readonly label: string;
  /**
   * Where the harness itself lives. Setup asks about installed software by
   * name, and a name is not enough to decide with: an operator meeting 'Moxxy'
   * on their first run needs to be told what it is, not left to search.
   */
  readonly homepage: string;
  readonly capabilities: HarnessCapabilities;
  /**
   * The models it ships, when `capabilities.models` is `builtin`. A fixed list
   * is a fact about the harness, so a machine running one needs no probe to
   * answer what it can run: the answer cannot change without a new release.
   */
  readonly models?: ReadonlyArray<string>;
}

/**
 * One harness a machine could be set to run, as first-run setup and the
 * machine's own settings page offer it.
 *
 * A harness that is not installed on that machine is NOT in this list. That is
 * the point of detecting rather than asking: the list is exactly as long as the
 * machine's real options, and an empty one is the only case that needs words.
 */
export interface HarnessOption {
  readonly id: string;
  readonly label: string;
  /** The harness's own site, so a first run can say what it is offering. */
  readonly homepage: string;
  /**
   * `ready` is on PATH with its own check passing. `installed` is on PATH and
   * will fail: it is offered unticked, with `detail` saying what is wrong and
   * `fix` naming the one command that repairs it.
   */
  readonly state: 'ready' | 'installed';
  readonly detail: string | null;
  readonly fix: string | null;
}

/** What a machine could run work through, and what it is set to run. */
export interface HarnessOptions {
  readonly options: ReadonlyArray<HarnessOption>;
  readonly selected: ReadonlyArray<string>;
}

/**
 * The harnesses in a set that report nothing a spend ceiling can count.
 *
 * A ceiling that quietly misses part of the bill is worse than no ceiling, so
 * every surface offering one names these rather than under-counting in silence.
 */
export function unmeteredHarnesses(
  harnesses: readonly HarnessDescriptor[],
): readonly HarnessDescriptor[] {
  return harnesses.filter((h) => h.capabilities.usage === 'none');
}

/**
 * Whether provider credentials decide which models this set can run.
 *
 * False for a harness that signs in on its own and ships a fixed list: provider
 * switches would control nothing there, and a model pin has no provider to
 * name. One provider-sourced harness is enough, since its models are still the
 * operator's to allow.
 */
export function servesProviderModels(harnesses: readonly HarnessDescriptor[]): boolean {
  return harnesses.some((h) => h.capabilities.models === 'providers');
}

// ---------- runs ----------

/**
 * What a queued unit of machine work is. `command` is the odd one: it occupies a
 * runner slot like the others but never creates a run row, because a pipeline's
 * executable step is a shell command, not an agent session. It is in this union
 * so it competes for capacity through the same scheduler instead of alongside it.
 */
export type RunKind =
  | 'interactive'
  | 'triage'
  | 'fix'
  | 'analysis'
  | 'implement'
  | 'report'
  | 'assistant'
  | 'command';

export type RunStatus =
  | 'queued'
  | 'provisioning'
  | 'running'
  /** Attended run (interactive chat / AI Help) whose gateway is live but no
   *  turn is in flight — it answered and is waiting for the next message. */
  | 'idle'
  | 'review'
  | 'completed'
  | 'abandoned'
  | 'interrupted'
  | 'failed'
  | 'stopped';

export interface RunRecord {
  readonly id: string;
  readonly kind: RunKind;
  readonly status: RunStatus;
  readonly title: string;
  readonly cwd: string;
  /** Repo this run belongs to, `owner/name`; null for scratch/interactive runs. */
  readonly repo: string | null;
  readonly issueNumber: number | null;
  readonly proposalId: string | null;
  /** Branch a fix/implement run works on (in its worktree). */
  readonly branch: string | null;
  readonly prUrl: string | null;
  /** Per-run model override; null rides the daemon default. */
  readonly model: string | null;
  /** Runner (machine) this run executes on; null = the built-in local runner. */
  readonly runnerId: string | null;
  /**
   * The agent runtime this run executes through, and what it can do. Carried on
   * the run rather than derived from its machine, because a machine may run
   * several and only the run knows which one it started under.
   */
  readonly harness: HarnessDescriptor;
  /**
   * User who owns this run. Attended chats (interactive / AI Help) are private
   * to their owner; null for automated/system runs (triage, digests, webhooks).
   */
  readonly userId: string | null;
  /**
   * The registered task this run serves (`RunTaskDescriptor.id`), which is the
   * unit cost attribution and model pins are both expressed in. null on runs
   * created before the column existed, and on paths that name no task.
   */
  readonly task: string | null;
  /**
   * Result of the pre-review verification, when this run had one. null on runs
   * that never reach review (chats, one-shots) and on runs predating the column.
   */
  readonly verification: RunVerification | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** True while a gateway process is attached (live transcript available). */
  readonly live: boolean;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Outcome summary (goal_complete/goal_abandon payload or error message). */
  readonly outcome: string | null;
}

/**
 * An unattended run waiting for a runner slot. It has no run row yet — it
 * becomes a real run only once it starts — so the queue is its own list the
 * user can watch, reorder, and cancel while runners are busy.
 */
export interface QueuedRunEntry {
  readonly id: string;
  readonly position: number;
  readonly kind: RunKind;
  readonly title: string;
  readonly repo: string | null;
  readonly issueNumber: number | null;
  /** Profile whose personal GitHub access authorized this repo-bound work. */
  readonly userId: string | null;
  /** Scheduling weight — higher starts sooner; sets the initial place in line. */
  readonly priority: number;
  readonly enqueuedAt: number;
}

/** The run scheduler's live state: how many are running vs the combined cap. */
export interface RunQueueSnapshot {
  readonly active: number;
  readonly capacity: number;
  readonly entries: readonly QueuedRunEntry[];
}

export interface CreateRunRequest {
  readonly kind?: RunKind;
  readonly title?: string;
  readonly prompt?: string;
}

export interface PromptRequest {
  readonly prompt: string;
  readonly model?: string;
}

export interface AskRespondRequest {
  readonly requestId: string;
  readonly response: {
    readonly mode?: 'allow' | 'allow_session' | 'allow_always' | 'deny';
    readonly optionId?: string;
    readonly text?: string;
  };
}

/**
 * One local-day bucket of token spend across the runs the viewer may see —
 * the dashboard burn chart's series (aggregated in SQL, zero-filled).
 */
export interface TokenUsageDay {
  /** Start of the local day, ms since epoch. */
  readonly dayStart: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** One model's window totals — a "most-used models" leaderboard row. */
export interface TokenUsageModel {
  /** Model id as recorded on the run; null = rode the daemon default. */
  readonly model: string | null;
  readonly runs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** The dashboard cost-analytics payload: daily series + per-model totals. */
export interface TokenUsage {
  readonly days: readonly TokenUsageDay[];
  readonly models: readonly TokenUsageModel[];
}

/**
 * What running the repository's own verification command in this run's worktree
 * found, before a human was asked to read the diff.
 *
 * 'unavailable' is its own state and not a failure: no command is configured, or
 * the machine is an older runner agent that cannot run one. "We did not check"
 * and "it does not build" must never render the same, because the second is
 * actionable and the first is a configuration gap.
 */
export interface RunVerification {
  readonly status: 'running' | 'passed' | 'failed' | 'unavailable';
  /** The command as configured; empty when nothing was configured. */
  readonly command: string;
  /** null while running, when unavailable, or when the process died on a signal. */
  readonly exitCode: number | null;
  /** Tail of the combined output, clipped. Empty while running. */
  readonly output: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
  readonly at: number;
}

// ---------- agent action policy ----------

/**
 * The effective limits on what agent work may do, as an instance states them.
 * Read-only: the values are module configuration, edited under Modules, so this
 * exists for the surface that displays them and for an auditor reading the
 * trail next to a refusal.
 */
export interface AgentPolicySnapshot {
  /** 'refused' makes agents read-only on every repository, on every runner. */
  readonly gitWrite: 'allowed' | 'refused';
  /**
   * Writes to the forge's API (comments, labels, reviews, merges). 'attended'
   * allows them only while a person is asking, so automation can analyse
   * continuously without anything appearing under the instance's identity
   * unprompted.
   */
  readonly gitHubWrite: 'allowed' | 'attended' | 'refused';
  /** Branch patterns agent work may never push to; `*` is the only wildcard. */
  readonly protectedBranches: readonly string[];
  /** Output tokens one run may burn before it is aborted. */
  readonly maxOutputTokens: number;
}

// ---------- spend budgets ----------

/** One budget ceiling and how far into it this period has got. */
export interface BudgetScopeStatus {
  /** The configured ceiling in USD; 0 means no ceiling is set for this scope. */
  readonly limitUsd: number;
  readonly spentUsd: number;
  /** Spend as a percentage of the ceiling; null when no ceiling is set. */
  readonly percent: number | null;
  /** The ceiling is set and reached: further runs in this scope are refused. */
  readonly exceeded: boolean;
}

/**
 * The instance's spend position for the current calendar month. `user` is the
 * requesting profile's own slice, so everyone can see how close they are to
 * their own ceiling without being able to read anyone else's.
 */
export interface BudgetStatus {
  /** First instant of the current calendar month, local time, ms since epoch. */
  readonly periodStart: number;
  readonly instance: BudgetScopeStatus;
  readonly user: BudgetScopeStatus;
  /** Percentage of a ceiling at which the operator is notified. */
  readonly alertPercent: number;
  /**
   * Tokens burned this period by models carrying no list price. This is real
   * money the ceiling cannot see, so it is reported rather than hidden: a
   * budget that silently ignores half the fleet is worse than no budget.
   */
  readonly unpricedTokens: number;
}

/** One row of "where did this period's spend go". */
export interface SpendEntry {
  /** Bucket key: a username, a task id, or `owner/name`. */
  readonly key: string;
  /** Display label; unattributed buckets say so rather than showing an empty cell. */
  readonly label: string;
  readonly runs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  /** Some of this bucket's tokens rode a model with no list price, so cost is a floor. */
  readonly partial: boolean;
}

/** Cost attribution for the current period, priced from the one pricing table. */
export interface SpendBreakdown {
  readonly periodStart: number;
  readonly byUser: readonly SpendEntry[];
  readonly byTask: readonly SpendEntry[];
  readonly byRepo: readonly SpendEntry[];
}

// ---------- runners (execution machines) ----------

export type RunnerKind = 'local' | 'remote';

/** Workspace reach: `shared` serves any workspace; `delegated` only assigned ones. */
export type RunnerScope = 'shared' | 'delegated';

export type RunnerStatus = 'online' | 'degraded' | 'offline' | 'unknown';

/** Live health of a runner, refreshed by the daemon's health poller. */
export interface RunnerHealth {
  readonly status: RunnerStatus;
  readonly moxxyVersion: string | null;
  readonly moxxyCompatible: boolean;
  readonly liveRuns: number;
  readonly maxRuns: number;
  readonly lastSeenAt: number | null;
  readonly detail: string | null;
  /**
   * Model provider names configured on the runner. null = unknown (old agent /
   * not probed yet) — placement assumes capable. Empty = can't serve any model.
   */
  readonly providers: readonly string[] | null;
  /**
   * The runner AGENT speaks an older protocol than this daemon — only an
   * on-machine agent update fixes it (set by the remote probe; absent
   * elsewhere). Distinct from moxxyCompatible, which the daemon can fix
   * remotely via update-moxxy.
   */
  readonly agentOutdated?: boolean;
}

/** Result of updating the moxxy CLI on a runner's machine. */
export interface RunnerMoxxyUpdateResult {
  readonly previous: string | null;
  readonly version: string | null;
  readonly compatible: boolean;
}

/** A runner's own provider/model catalog, fetched live from its moxxy. */
export interface RunnerCatalog {
  readonly providers: ReadonlyArray<ModelCatalogProvider>;
  readonly defaultModel: string | null;
  readonly fetchedAt: number;
}

/**
 * A feature-level unit of agent work ('board.worker', 'code.fix',
 * 'automations.digest'), registered by its owning module. It is the unit both
 * placement (runners include/exclude tasks) and model policy (instance-wide
 * task pins) are expressed in. Finer than RunKind, which only classifies how a
 * run behaves: board workers and user-triggered implement runs share a kind but
 * are different work. Registration is in-memory at module enable; a disabled
 * module's entries linger until restart (the same discipline as queue
 * resumers).
 */
export interface RunTaskDescriptor {
  /** `<moduleId>.<name>`: the prefix names the owning module, which is how
   *  instance settings group tasks without a second registry. */
  readonly id: string;
  readonly label: string;
  /**
   * False = this task's runs prepare their working directory on the daemon's
   * own machine, so they land there without consulting placement. A fact about
   * how the work is built, not a setting: the settings page states it instead
   * of rendering a control nobody turned off. The machine's policy still
   * governs the runs of such a task that DO reach placement (a few prepare a
   * shared snapshot instead), which is why a module-level entry covers them.
   */
  readonly placeable: boolean;
  readonly hint?: string;
}

/**
 * How a machine's task policy is read. `deny` is OPEN by default — everything
 * except the listed entries — so a module update that registers a new task
 * starts allowed everywhere. `allow` is CLOSED by default: only the listed
 * entries, which is how an operator says "this machine does exactly these
 * things and nothing else" and has it stay true across upgrades.
 */
export type RunnerPolicyMode = 'allow' | 'deny';

/**
 * What a machine may be used for, at two levels. A MODULE entry means
 * everything that module registers NOW AND IN FUTURE — that is the whole point
 * of the level, so it is stored as the module id and never expanded into the
 * task ids that happen to exist today. A TASK entry names one unit of work, so
 * "implements but does not review" stays expressible underneath a module row.
 *
 * Full replacement on write. Both lists tolerate ids whose module is disabled:
 * the decision must outlive the module being switched off.
 */
export interface RunnerTaskPolicy {
  readonly mode: RunnerPolicyMode;
  /** Module ids (`code`) — blanket entries over everything they register. */
  readonly modules: readonly string[];
  /** Task ids (`code.fix`) — individual entries under a module. */
  readonly tasks: readonly string[];
}

/** The deny-nothing policy: what every machine carried before modes existed. */
export const OPEN_TASK_POLICY: RunnerTaskPolicy = { mode: 'deny', modules: [], tasks: [] };

/** The module that registered a task, read off its `<moduleId>.<name>` id. */
export function taskModuleId(taskId: string): string {
  const dot = taskId.indexOf('.');
  return dot === -1 ? taskId : taskId.slice(0, dot);
}

/** Does the policy name this task, directly or through its module blanket? */
export function taskPolicyLists(policy: RunnerTaskPolicy, taskId: string): boolean {
  return policy.modules.includes(taskModuleId(taskId)) || policy.tasks.includes(taskId);
}

/**
 * May a machine carrying this policy run this task? The single definition both
 * placement and the settings page read, so what the operator sees ticked is
 * what the server applies.
 */
export function taskPolicyAllows(policy: RunnerTaskPolicy, taskId: string): boolean {
  return policy.mode === 'allow' ? taskPolicyLists(policy, taskId) : !taskPolicyLists(policy, taskId);
}

/**
 * How a policy answers a whole module, tasks it registers LATER included.
 *  - `all`/`none`: the module is governed uniformly and keeps being governed
 *    that way as it grows;
 *  - `partial`: individual task entries pin it to the tasks that exist today.
 */
export type ModulePolicyReach = 'all' | 'none' | 'partial';

/**
 * A module's answer for work that does not exist yet.
 *
 * Uniform is NOT the same as "carries a blanket entry": under `deny`, covering
 * everything now and later is expressed by the ABSENCE of any entry, which is
 * exactly the state every machine starts in. What breaks uniformity is an
 * individual task entry, because only those fail to reach a task added later.
 */
export function moduleTaskPolicyReach(policy: RunnerTaskPolicy, moduleId: string): ModulePolicyReach {
  const blanket = policy.modules.includes(moduleId);
  if (!blanket && policy.tasks.some((id) => taskModuleId(id) === moduleId)) return 'partial';
  return blanket === (policy.mode === 'allow') ? 'all' : 'none';
}

/** Set every task of a module, present and future, to one answer. */
export function withModuleAllowed(policy: RunnerTaskPolicy, moduleId: string, allowed: boolean): RunnerTaskPolicy {
  // The blanket subsumes any individual entries underneath it, so they go.
  const tasks = policy.tasks.filter((id) => taskModuleId(id) !== moduleId);
  const listed = allowed === (policy.mode === 'allow');
  const modules = listed
    ? [...policy.modules.filter((m) => m !== moduleId), moduleId]
    : policy.modules.filter((m) => m !== moduleId);
  return { ...policy, modules, tasks };
}

/**
 * Set one task's answer. Doing so under a module blanket expands that blanket
 * over the tasks that exist today and drops it, because "everything this module
 * registers" and "everything but this one" cannot both be true. Tasks the
 * module adds later stop being covered, which is what per-task control means.
 */
export function withTaskAllowed(
  policy: RunnerTaskPolicy,
  groups: readonly RunTaskGroup[],
  taskId: string,
  allowed: boolean,
): RunnerTaskPolicy {
  const moduleId = taskModuleId(taskId);
  let modules = policy.modules;
  let tasks = policy.tasks;
  if (modules.includes(moduleId)) {
    const siblings = groups.find((g) => g.moduleId === moduleId)?.tasks ?? [];
    modules = modules.filter((m) => m !== moduleId);
    tasks = [...new Set([...tasks, ...siblings.map((t) => t.id)])];
  }
  const listed = allowed === (policy.mode === 'allow');
  return {
    ...policy,
    modules,
    tasks: listed ? [...new Set([...tasks, taskId])] : tasks.filter((id) => id !== taskId),
  };
}

/** Drop one module or task entry, whichever it is. */
export function withoutTaskPolicyEntry(policy: RunnerTaskPolicy, id: string): RunnerTaskPolicy {
  return {
    ...policy,
    modules: policy.modules.filter((m) => m !== id),
    tasks: policy.tasks.filter((t) => t !== id),
  };
}

/**
 * Rewrite a policy into the other mode, preserving what the machine may do
 * TODAY: a fully-allowed module becomes a blanket entry, a partly-allowed one
 * becomes its individual tasks. What changes is the future, which is the whole
 * reason to switch: an allow-list stops covering tasks a module adds later,
 * and a deny-list starts covering them.
 *
 * Entries for modules not in this build are dropped: their effective answer
 * survives either way, because an unlisted id is allowed under `deny` and
 * refused under `allow`, which is exactly what they were.
 */
export function convertPolicyMode(
  policy: RunnerTaskPolicy,
  groups: readonly RunTaskGroup[],
  mode: RunnerPolicyMode,
): RunnerTaskPolicy {
  if (mode === policy.mode) return policy;
  const modules: string[] = [];
  const tasks: string[] = [];
  for (const group of groups) {
    const listed = group.tasks.filter((task) => taskPolicyAllows(policy, task.id) === (mode === 'allow'));
    if (listed.length === group.tasks.length) modules.push(group.moduleId);
    else tasks.push(...listed.map((task) => task.id));
  }
  return { mode, modules, tasks };
}

/** Repository reach: `all` takes any repo's work; `selected` only the cleared ones. */
export type RunnerRepoScope = 'all' | 'selected';

/**
 * What happens to a run no eligible machine's policy accepts.
 *  - `policy` — the daemon's own machine takes it only if ITS policy does
 *    (the default: identical to the old last-resort on a deny-list instance,
 *    and a visible refusal on an allow-list one);
 *  - `local` — the daemon's machine always takes it (pre-policy behaviour);
 *  - `refuse` — nothing absorbs it; the run fails naming the policy.
 */
export type RunnerFallback = 'policy' | 'local' | 'refuse';

/**
 * An execution host. The built-in `local` runner (id `runner-local`) always
 * exists, is `shared`, and cannot be deleted. `remote` runners are other
 * machines running the companion-runner agent, reached at `endpoint` with a
 * bearer `token` (write-only; never returned).
 *
 * Three different things live here and read differently:
 *  - CAPABILITY (`health`, `catalog`) is discovered by probing the machine —
 *    never a setting;
 *  - POLICY (`taskPolicy`, `providerPolicy`) is what it is allowed to do;
 *  - PLACEMENT (`scope`/`workspaceIds`, `repoScope`/`repoIds`, `allowedRoles`,
 *    `ownerId`, `enabled`) is where it participates, and `maxRuns` is the
 *    machine's own capacity.
 */
export interface RunnerRecord {
  readonly id: string;
  readonly name: string;
  readonly kind: RunnerKind;
  readonly endpoint: string | null;
  /** True once a token is stored (the token itself never leaves the daemon). */
  readonly hasToken: boolean;
  /**
   * Owning user, or null for a shared instance-wide runner. A personal runner
   * only receives runs its owner triggers — their own machine, their own
   * model subscription.
   */
  readonly ownerId: string | null;
  readonly scope: RunnerScope;
  readonly workspaceIds: ReadonlyArray<string>;
  readonly maxRuns: number;
  readonly enabled: boolean;
  /**
   * What this machine is allowed to be used for. A hard placement filter that
   * outranks the repo pin; where nothing accepts a run, the instance's
   * `RunnerFallback` decides whether the daemon's machine absorbs it.
   */
  readonly taskPolicy: RunnerTaskPolicy;
  /** `selected` limits this machine to `repoIds`; work on any other repo (and
   *  repo-less work, which has nothing to clear) is placed elsewhere. */
  readonly repoScope: RunnerRepoScope;
  /** Repositories this machine is cleared for, `owner/name`. */
  readonly repoIds: ReadonlyArray<string>;
  /**
   * Roles whose users may place work here; empty = every role. Automated work
   * has no triggering role, so a restricted machine never receives it.
   */
  readonly allowedRoles: ReadonlyArray<string>;
  readonly health: RunnerHealth;
  /**
   * The agent runtimes this machine runs work through. Never empty: a machine
   * that can run nothing would silently accept placements it cannot serve.
   */
  readonly harnesses: ReadonlyArray<HarnessDescriptor>;
  readonly catalog: RunnerCatalog | null;
  /** Which of this machine's providers/models agents may use (see the type). */
  readonly providerPolicy: RunnerProviderPolicy;
  readonly createdAt: number;
}

/** Viewer-specific runner-pool occupancy: shared runners plus their own private ones. */
export interface RunnerCapacitySnapshot {
  readonly active: number;
  readonly capacity: number;
}

export interface CreateRunnerRequest {
  readonly name: string;
  readonly endpoint: string;
  readonly token: string;
  /** Admin-only: true = instance-wide (no owner). Otherwise the runner is private to its creator. */
  readonly shared?: boolean;
  readonly scope?: RunnerScope;
  readonly workspaceIds?: ReadonlyArray<string>;
  readonly maxRuns?: number;
  readonly taskPolicy?: RunnerTaskPolicy;
}

export interface UpdateRunnerRequest {
  readonly name?: string;
  readonly endpoint?: string;
  /** New bearer token; omit to keep the current one. */
  readonly token?: string;
  readonly scope?: RunnerScope;
  readonly workspaceIds?: ReadonlyArray<string>;
  readonly maxRuns?: number;
  readonly enabled?: boolean;
  /** Full replacement policy; omit to keep the current one. */
  readonly taskPolicy?: RunnerTaskPolicy;
  readonly repoScope?: RunnerRepoScope;
  readonly repoIds?: ReadonlyArray<string>;
  /** Full replacement role list; empty opens the machine to every role. */
  readonly allowedRoles?: ReadonlyArray<string>;
  /**
   * Which agent runtimes this machine runs work through, in preference order:
   * a run takes the first one. Full replacement; omit to keep the current set.
   * An empty list is refused, because a machine that can run nothing would
   * still accept placements.
   */
  readonly harnesses?: ReadonlyArray<string>;
}

/** One module's registered run tasks — the policy tree's top level. */
export interface RunTaskGroup {
  readonly moduleId: string;
  /** That module's title, or the raw id when it is not in this build. */
  readonly moduleTitle: string;
  readonly tasks: ReadonlyArray<RunTaskDescriptor>;
}

/** A repository a machine can be cleared for. */
export interface RunnerRepoRef {
  readonly fullName: string;
  readonly workspaceId: string | null;
}

/**
 * What a machine's policy and placement can be written against: the registered
 * work grouped by owning module, the repositories the viewer may see, and this
 * instance's role ids. Its own route because it changes with the module set and
 * the repo list, not with health — the runners payload is re-read on every
 * `runners.changed`, which fires on every health flap.
 */
export interface RunnerPolicyOptions {
  readonly groups: ReadonlyArray<RunTaskGroup>;
  readonly repos: ReadonlyArray<RunnerRepoRef>;
  readonly roles: ReadonlyArray<string>;
}

/** Result of probing a runner's endpoint (the "Test connection" action). */
export interface RunnerProbeResult {
  readonly ok: boolean;
  readonly health: RunnerHealth;
  readonly catalog: RunnerCatalog | null;
}

// ---------- moxxy / model catalog ----------

export interface MoxxyStatus {
  readonly cliPath: string | null;
  readonly cliVersion: string | null;
  readonly compatible: boolean;
  readonly homeDir: string;
  readonly homeReady: boolean;
  readonly providersImported: boolean;
  readonly githubConfigured: boolean;
  readonly githubUser: string | null;
}

export interface ModelCatalogModel {
  readonly id: string;
  readonly contextWindow: number | null;
}

export interface ModelCatalogProvider {
  readonly name: string;
  readonly enabled: boolean;
  /** Credentials resolved — moxxy can actually serve this provider. */
  readonly ready: boolean;
  readonly models: ReadonlyArray<ModelCatalogModel>;
}

/** Connected providers + their models, read live from a run's gateway. */
export interface ModelCatalog {
  readonly activeProvider: string | null;
  readonly providers: ReadonlyArray<ModelCatalogProvider>;
  /** Model the next turn of this run will use (override or daemon default). */
  readonly current: string;
  readonly defaultModel: string;
}

export interface SetRunModelRequest {
  /** null clears the override (back to the daemon default). */
  readonly model: string | null;
  /** Switch the session's active provider first (for provider-scoped models). */
  readonly provider?: string;
}

/**
 * The provider/model view behind the Providers page: one group per machine
 * (what it reported plus its own policy) and the merged effective set, which
 * answers what a per-machine page cannot: can agents use model X at all. There
 * is no second catalog — runner catalogs are the only source, refreshed by the
 * daemon (bind, health TTL, live runs, provider import).
 *
 * Scoped to the viewer: shared machines plus their own, matching who may
 * actually place runs on them.
 */
export interface ProviderCatalog {
  /** The merged effective set: only what some visible machine can serve now. */
  readonly providers: ReadonlyArray<CatalogProvider>;
  readonly machines: ReadonlyArray<CatalogMachine>;
  readonly defaultModel: string;
  /** Newest per-machine fetch across the pool; null = nothing fetched yet. */
  readonly fetchedAt: number | null;
}

export interface CatalogProvider {
  readonly name: string;
  /** Runner ids where it has credentials AND is enabled. */
  readonly machines: ReadonlyArray<string>;
  /** Runner ids that have credentials for it but where it is switched off. */
  readonly disabledOn: ReadonlyArray<string>;
  readonly models: ReadonlyArray<CatalogModel>;
}

export interface CatalogModel {
  readonly id: string;
  readonly contextWindow: number | null;
  /** Runner ids that can serve this model right now. */
  readonly machines: ReadonlyArray<string>;
}

/** A machine's own group: what its moxxy reported and what it allows. */
export interface CatalogMachine {
  readonly id: string;
  readonly name: string;
  readonly online: boolean;
  /** When this machine's catalog was last fetched; null = never. */
  readonly fetchedAt: number | null;
  /** Models this machine can serve right now (ready provider, enabled here). */
  readonly modelCount: number;
  /**
   * Whether provider credentials decide what this machine can run at all. False
   * where every harness on it brings its own models, which makes every control
   * below dead: there is no provider to switch off and no credential to add.
   */
  readonly providerModels: boolean;
  readonly providers: ReadonlyArray<CatalogMachineProvider>;
  /**
   * This machine's stored policy, verbatim. The page edits and sends back this
   * list rather than rebuilding it from the switches: a disabled id may be
   * bare or provider-scoped, and re-deriving it would silently rewrite one
   * form into the other.
   */
  readonly policy: RunnerProviderPolicy;
}

export interface CatalogMachineProvider {
  readonly name: string;
  /** Credentials resolved on this machine. */
  readonly ready: boolean;
  /** This machine's policy: agents may use it here. */
  readonly enabled: boolean;
  readonly models: ReadonlyArray<CatalogMachineModel>;
}

export interface CatalogMachineModel {
  readonly id: string;
  readonly contextWindow: number | null;
  /** This machine's policy: agents may use it here. */
  readonly enabled: boolean;
}

/**
 * One machine's provider policy. Scoped per runner because catalogs are: a
 * provider can be credential-ready on one machine and absent on another, so an
 * instance-wide list could not express "on here, not there". Full replacement
 * on write; empty lists allow everything the machine can serve.
 */
export interface RunnerProviderPolicy {
  readonly disabledProviders: ReadonlyArray<string>;
  /** Model ids, bare (`opus`) or provider-scoped (`anthropic/opus`). */
  readonly disabledModels: ReadonlyArray<string>;
}

/**
 * What the fleet has been able to establish about provider credentials. The
 * third state is the point: a machine nobody has read yet must not be reported
 * as having nothing, or the page tells the operator to fix a problem that may
 * not exist.
 */
export type ProviderDetection =
  /** At least one machine holds credentials for these providers. */
  | { readonly state: 'found'; readonly providers: readonly string[]; readonly machines: number }
  /** Every visible machine was read, and none holds any credentials. */
  | { readonly state: 'none' }
  /**
   * There are machines, and not one of them takes its models from a provider.
   * Distinct from `none`: nothing is missing and there is nothing to configure,
   * so telling the operator to add credentials would send them after a problem
   * they do not have.
   */
  | { readonly state: 'builtin' }
  /**
   * Nothing found, and something is still unread. `reading` machines are online
   * and will report on their own; `unreachable` ones will not until they come
   * back, so the two cannot be described to the operator with one sentence.
   */
  | { readonly state: 'unknown'; readonly reading: number; readonly unreachable: number };

/**
 * Read the catalog for whether anything is actually configured anywhere.
 *
 * A provider NAME alone proves nothing: the merged list also carries providers
 * named by the daemon's own moxxy config that no machine can serve, which is
 * exactly the case the page must not call "found". `found` therefore needs a
 * machine that reported the provider ready, including one where the operator
 * switched it off, since that is a setting to flip, not a dead end.
 *
 * Only ONLINE machines are ever catalog-probed, so an offline machine that has
 * never reported stays unread indefinitely; counting it as "reading" would
 * promise an answer the daemon is not going to fetch.
 *
 * A machine whose harnesses bring their own models is never going to report a
 * provider, so it is left out of the count entirely rather than sitting in
 * "reading" forever.
 */
export function detectProviders(catalog: ProviderCatalog): ProviderDetection {
  const credentialed = catalog.providers.filter((p) => p.machines.length > 0 || p.disabledOn.length > 0);
  if (credentialed.length > 0) {
    const machines = new Set(credentialed.flatMap((p) => [...p.machines, ...p.disabledOn]));
    return { state: 'found', providers: credentialed.map((p) => p.name), machines: machines.size };
  }
  const asked = catalog.machines.filter((m) => m.providerModels);
  if (asked.length === 0) return catalog.machines.length > 0 ? { state: 'builtin' } : { state: 'none' };
  const unread = asked.filter((m) => m.fetchedAt === null);
  if (unread.length === 0) return { state: 'none' };
  const reading = unread.filter((m) => m.online).length;
  return { state: 'unknown', reading, unreachable: unread.length - reading };
}

// ---------- task model pins ----------

/**
 * One registered task and the model bound to it. Pins are instance-wide: a task
 * is the unit of work people reason about ("issue triage", "board workers"), so
 * it is the unit model policy is expressed in. Machines carry capability and
 * placement, never model policy.
 */
export interface TaskModelPin {
  readonly task: RunTaskDescriptor;
  /** Task id prefix: the module that registered it. */
  readonly moduleId: string;
  /** That module's title, or the raw id when it is not in this build. */
  readonly moduleTitle: string;
  /**
   * The pin exactly as stored; null = the task rides the instance default. A
   * model no machine can serve right now stays visible here rather than reading
   * as unpinned, so an edit never silently discards it. Dispatch resolves it per
   * run (see the cascade in Orchestrator) and drops it where it cannot be met.
   */
  readonly model: string | null;
}

/** The Task models settings payload: what can be pinned, to what, and the fallback. */
export interface TaskModelSnapshot {
  readonly tasks: ReadonlyArray<TaskModelPin>;
  /**
   * The only models offerable as a pin: those some enabled SHARED machine is
   * capable of serving, deduplicated across providers. Capability, not
   * availability, so the list does not flicker with health; a pin the machine a
   * run lands on cannot serve gives way to that machine's default. Personal
   * machines are left out because unattended work never places there, so such a
   * pin would never apply to the work it was set for.
   */
  readonly models: ReadonlyArray<CatalogModel>;
  /** Where every unpinned task lands (the daemon's configured model). */
  readonly defaultModel: string;
}

/** State of the instance-wide webhook tunnel (public delivery via moxxy proxy). */
export interface WebhookTunnelState {
  readonly enabled: boolean;
  readonly status: 'off' | 'connecting' | 'connected' | 'error';
  /** Public base URL while up (e.g. https://<uuid>.proxy.moxxy.ai/gh). */
  readonly url: string | null;
  /** Sanitized operator-facing failure; relay internals stay in server logs. */
  readonly error: string | null;
}

// ---------- skills ----------

export interface SkillFile {
  readonly name: string;
  readonly content: string;
  readonly updatedAt: number;
}
