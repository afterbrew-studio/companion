import { randomUUID } from 'node:crypto';
import type { SpaServerMessage } from '@moxxy/companion-contracts';
import type { AgentStorageCleanupRequest } from '@moxxy/companion-types';
import type {
  CatalogMachine,
  CatalogMachineModel,
  CatalogMachineProvider,
  CatalogModel,
  CatalogProvider,
  CreateRunnerRequest,
  GitCredentialResolver,
  HarnessDescriptor,
  HarnessOption,
  HarnessOptions,
  ModelCatalogModel,
  ModelCatalogProvider,
  ProviderCatalog,
  RunnerCatalog,
  RunnerFallback,
  RunnerHealth,
  RunnerProbeResult,
  RunnerRuntimeHealth,
  RunnerProviderPolicy,
  RunnerRecord,
  RunnerRepoRef,
  RunnerTaskPolicy,
  UpdateRunnerRequest,
} from '../contract/index.js';
import { servesProviderModels, taskPolicyAllows } from '../contract/index.js';
import { log, paths } from '@moxxy/companion-services';
import { detectHarnesses, type HarnessDetection } from '../exec/harness-detect.js';
import { builtinCatalog, describeHarness, harnessSet, MOXXY_HARNESS, offeredHarnesses } from './harnesses.js';
import type { OperateStore } from './operate-store.js';
import { LOCAL_RUNNER_ID, type RunnerRow } from './runners-store.js';
import type { Checkouts } from '../exec/checkouts.js';
import type { MoxxyCli } from '../exec/cli.js';
import type { RunnerBackend, RunnerEventSink } from './backend.js';
import { LocalRunnerBackend, type LocalRunSpec } from './local-backend.js';
import { RemoteRunnerBackend } from './remote-backend.js';

/** What legacy remote agents are offered until they report their runtime list. */
const MOXXY_OPTION: HarnessOption = {
  id: MOXXY_HARNESS.id,
  label: MOXXY_HARNESS.label,
  homepage: MOXXY_HARNESS.homepage,
  state: 'ready',
  detail: null,
  fix: null,
};

const HEALTH_POLL_MS = 30_000;
const STORAGE_CLEANUP_MS = 6 * 60 * 60_000;
/** How long a machine's fetched catalog is trusted before a background re-probe. */
const CATALOG_TTL_MS = 6 * 60 * 60_000;
/** Backoff after a failed probe so an unreachable machine isn't retried every tick. */
const CATALOG_RETRY_MS = 10 * 60_000;
/** How long "what is installed here" is trusted; installing something is rare. */
const DETECT_TTL_MS = 60_000;
const UNKNOWN_HEALTH: RunnerHealth = {
  status: 'unknown',
  runtimes: [],
  liveRuns: 0,
  maxRuns: 0,
  lastSeenAt: null,
  detail: null,
};

/**
 * Instance-level inputs placement resolves live, rather than at construction:
 * roles are stored by module-core and edited at runtime, and the fallback is
 * module config an admin can change without a restart.
 */
export interface RunnersPolicySource {
  /** Effective role of a triggering user; null when unknown. */
  roleOf?(username: string): string | null;
  /** What happens to work no eligible machine's policy accepts. */
  fallback?(): RunnerFallback;
  /** Instance agent policy: refuses a push whose target branch is protected. */
  assertPushTarget?(repo: string, branch: string): void;
}

/**
 * Owns one RunnerBackend per registered runner, polls their health, and makes
 * placement decisions. The local runner's backend is the same GatewayPool that
 * used to live in the orchestrator; remote backends are (re)built whenever a
 * runner's endpoint/token changes. All backends feed one shared event sink so
 * the orchestrator can't tell local from remote.
 */
export class Runners {
  private readonly backends = new Map<string, RunnerBackend>();
  private readonly health = new Map<string, RunnerHealth>();
  private readonly local: LocalRunnerBackend;
  private healthTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private readonly cleanupInFlight = new Set<string>();
  /** In-flight catalog fetches, so concurrent callers share one probe. */
  private readonly catalogInFlight = new Map<string, Promise<RunnerCatalog | null>>();
  /** Last fetch attempt per runner — drives the failure backoff. */
  private readonly catalogAttempt = new Map<string, number>();
  /**
   * model id (bare AND `provider/id`) → the runners that can serve it right
   * now. A key exists as soon as any machine's catalog lists the model, so a
   * MISSING key means "no machine has ever mentioned it" while an EMPTY set
   * means "known, but no machine may run it". Callers depend on that
   * distinction to refuse only on evidence.
   */
  private modelServers = new Map<string, Set<string>>();
  /** Cached `detectHarnesses` answer for this machine (see `detected`). */
  private detectedHarnesses: readonly HarnessDetection[] | null = null;
  private detectedAt = 0;

  constructor(
    private readonly store: OperateStore,
    checkouts: Checkouts,
    moxxyCli: MoxxyCli | null,
    maxLiveRuns: number,
    private readonly sink: RunnerEventSink,
    private readonly broadcast: (msg: SpaServerMessage) => void,
    /** Hub GitHub credential remote agents receive with network git calls. */
    private readonly githubTokenFor: GitCredentialResolver = () => null,
    private readonly storagePolicy: () => Omit<AgentStorageCleanupRequest, 'runs'> = () => ({
      worktreeRetentionMs: 3 * 24 * 60 * 60_000,
      scratchRetentionMs: 24 * 60 * 60_000,
      sessionRetentionMs: 30 * 24 * 60 * 60_000,
    }),
    private readonly instancePolicy: RunnersPolicySource = {},
  ) {
    this.local = new LocalRunnerBackend(
      LOCAL_RUNNER_ID,
      checkouts,
      moxxyCli?.path ?? 'moxxy',
      maxLiveRuns,
      sink,
      {
        runSpec: (runId) => this.localRunSpec(runId),
        harnesses: () => this.harnessesOn(this.store.runners.get(LOCAL_RUNNER_ID)!).map((h) => h.id),
        runtime: async (id): Promise<RunnerRuntimeHealth> => {
          const found = (await this.detected()).find((d) => d.id === id);
          const descriptor = this.harnessesOn(this.store.runners.get(LOCAL_RUNNER_ID)!).find((h) => h.id === id);
          if (!found || !descriptor) {
            return {
              id,
              label: descriptor?.label ?? id,
              version: null,
              state: 'unavailable',
              detail: `${id} is not a runtime this build can run`,
            };
          }
          return {
            id,
            label: descriptor.label,
            version: found.version,
            state: found.state === 'ready' ? 'ready' : 'unavailable',
            detail: found.state === 'ready' ? null : (found.detail ?? `${id} is not ready on this machine`),
          };
        },
      },
    );
    this.backends.set(LOCAL_RUNNER_ID, this.local);
    this.rebuildRemotes();
    this.rebuildModelIndex();
  }

  /** The always-present local backend (used for shutdown-all). */
  get localBackend(): LocalRunnerBackend {
    return this.local;
  }

  start(): void {
    void this.pollHealth().then(() => this.enforceStorageCleanup());
    this.healthTimer = setInterval(() => void this.pollHealth(), HEALTH_POLL_MS);
    this.healthTimer.unref();
    this.cleanupTimer = setInterval(() => void this.enforceStorageCleanup(), STORAGE_CLEANUP_MS);
    this.cleanupTimer.unref();
  }

  stop(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    for (const backend of this.backends.values()) {
      if (backend instanceof RemoteRunnerBackend) backend.dispose();
    }
  }

  /**
   * A fresh or upgraded instance with no recorded runtime choice adopts every
   * detected ready runtime. First-run setup may persist an explicit selection
   * before this runs; that choice is never overwritten.
   */
  async adoptDetectedRuntimes(): Promise<void> {
    const row = this.store.runners.get(LOCAL_RUNNER_ID);
    if (!row || row.harnesses.length > 0) return;
    const ready = offeredHarnesses(await this.detected())
      .filter((runtime) => runtime.state === 'ready')
      .map((runtime) => runtime.id);
    if (ready.length === 0) return;
    this.store.runners.update(LOCAL_RUNNER_ID, { harnesses: ready });
    this.rebuildModelIndex();
    this.broadcast({ t: 'runners.changed' });
    log.info('adopted detected agent runtimes for this machine', { runtimes: ready });
  }

  /** (Re)create remote backends to match the stored runner rows. */
  private rebuildRemotes(): void {
    const rows = this.store.runners.list().filter((r) => r.kind === 'remote');
    const wanted = new Set(rows.map((r) => r.id));
    // Drop backends whose runner vanished.
    for (const [id, backend] of this.backends) {
      if (id !== LOCAL_RUNNER_ID && !wanted.has(id)) {
        (backend as RemoteRunnerBackend).dispose();
        this.backends.delete(id);
        this.health.delete(id);
      }
    }
    for (const row of rows) {
      if (!row.endpoint || !row.token) continue;
      // Rebuild fresh so endpoint/token edits take effect.
      const existing = this.backends.get(row.id);
      if (existing) (existing as RemoteRunnerBackend).dispose();
      this.backends.set(
        row.id,
        new RemoteRunnerBackend(
          row.id,
          row.endpoint,
          row.token,
          this.sink,
          this.githubTokenFor,
          (up) => {
            // Event-stream state is the fastest liveness signal: a drop (or a
            // reconnect) triggers an immediate probe instead of waiting out the
            // poll interval. Once health already says offline, the retry loop's
            // repeated drops stop re-probing.
            if (up || this.health.get(row.id)?.status !== 'offline') void this.probeOne(row.id);
          },
          (repo, branch) => this.instancePolicy.assertPushTarget?.(repo, branch),
        ),
      );
    }
  }

  /** Backend for a specific runner id (falls back to local for null/unknown). */
  backend(runnerId: string | null): RunnerBackend {
    if (!runnerId) return this.local;
    return this.backends.get(runnerId) ?? this.local;
  }

  /** Backend a run executes on. */
  backendForRun(runnerId: string | null): RunnerBackend {
    return this.backend(runnerId);
  }

  // ---------- placement ----------

  /**
   * Choose a runner for a new run. Preference order: the repo's pinned runner
   * (if eligible + healthy), then the least-loaded online eligible runner,
   * then local as the always-available fallback. Returns the runner id (null
   * means the local runner).
   *
   * Provider capability: runners whose catalog leaves ZERO usable providers
   * (none credential-ready, or all switched off here) can't serve any model
   * and are never chosen; an unfetched catalog stays optimistic. Runners that
   * may actually run `wantedModel` are preferred; if none can, placement falls
   * back to the capability-agnostic choice and the turn refuses with a clear
   * error instead (see Orchestrator.sendPrompt).
   *
   * Ownership: `userId` is the triggering user. Their personal runners become
   * eligible AND preferred (their machine, their subscription); other users'
   * runners never are. Automation passes null and rides shared runners only.
   *
   * Task eligibility: a runner never receives work its task policy excludes —
   * a hard filter that outranks even the repo pin — nor work outside its
   * repository clearance or its allowed roles. An unlabeled run (`task` null)
   * passes every task policy.
   *
   * Where nothing eligible can take the run, `fallbackTarget` decides whether
   * the daemon's own machine absorbs it; when it refuses, this THROWS naming
   * the policy, because a run silently landing on the one machine the policy
   * meant to protect is the failure this exists to prevent.
   */
  place(
    repo: string | null,
    task: string | null,
    wantedModel?: string | null,
    userId: string | null = null,
    /** Runner row ids to skip — failover after a spawn just failed there. */
    exclude?: ReadonlySet<string>,
  ): string | null {
    const workspaceId = repo ? (this.store.repos.get(repo)?.workspace_id ?? null) : null;
    // Kept as stages, not one chained filter, so a refusal can name the fence
    // that actually rejected the run rather than blaming the first one.
    const reachable = this.store.runners.eligibleFor(workspaceId, userId).filter((r) => !exclude?.has(r.id));
    const byTask = reachable.filter((r) => this.allows(r, task));
    const byRepo = byTask.filter((r) => this.servesRepo(r, repo));
    const eligible = byRepo.filter((r) => this.servesRole(r, userId));
    const pinned = repo ? (this.store.repos.get(repo)?.runner_id ?? null) : null;

    const online = (row: RunnerRow): boolean => {
      const h = this.health.get(row.id);
      // Remote runners must complete a successful probe before placement. An
      // unprobed or degraded remote may speak an older agent protocol and
      // silently discard prompt fields it does not understand (such as image
      // attachments). The in-process local runner is safe to use immediately.
      if (!h || h.status === 'unknown') return row.id === LOCAL_RUNNER_ID;
      return h.status === 'online';
    };
    // A runner is usable only if it has a credential-ready provider (its
    // catalog says so). Unknown catalog (never probed) stays optimistic.
    const ready = (row: RunnerRow): boolean => this.hasReadyProvider(row);
    // Load counts runs already assigned to a runner (provisioning included), not
    // just spawned gateways — so a batch placed back-to-back spreads instead of
    // piling onto whichever runner currently shows zero live gateways.
    const active = this.store.runs.activeCountsByRunner();
    const load = (row: RunnerRow): number => {
      return this.activeRuns(row, active) / Math.max(1, row.max_runs);
    };

    if (pinned) {
      // An explicit repo pin wins, but not over a runner that can't run anything.
      const pin = eligible.find((r) => r.id === pinned);
      if (pin && online(pin) && ready(pin) && load(pin) < 1) return this.normalize(pin.id);
    }
    // The user's own machines come first (that's what they connected them
    // for), then shared runners; within each tier least-loaded first. An own
    // runner at capacity drops to the shared tier — preferring it would pick a
    // full machine over an idle shared one and fail the spawn outright.
    const own = (row: RunnerRow): number =>
      userId !== null && row.owner_id === userId && load(row) < 1 ? 0 : 1;
    const usable = eligible
      .filter(online)
      .filter(ready)
      .filter((row) => load(row) < 1)
      .sort((a, b) => own(a) - own(b) || load(a) - load(b));
    const servers = this.runnersForModel(wantedModel ?? null);
    const chosen = usable.find((row) => rowServes(row, servers)) ?? usable[0];
    if (chosen) return this.normalize(chosen.id);
    if (this.fallbackTarget(task) === 'local') return this.normalize(LOCAL_RUNNER_ID);
    const what = task ?? 'this run';
    const why =
      reachable.length === 0
        ? 'no machine is available to this run'
        : byTask.length === 0
          ? `no machine's task policy accepts ${what}`
          : byRepo.length === 0
            ? repo === null
              ? 'no machine takes work that belongs to no repository'
              : `no machine is cleared for ${repo}`
            : eligible.length === 0
              ? userId === null
                ? 'no machine accepts automated work'
                : `no machine serves ${userId}'s role`
              : `every machine that accepts ${what} is offline or full`;
    throw new Error(this.refusalMessage(why));
  }

  /**
   * Where a run nobody eligible could take goes. Under an allow-list fleet the
   * old unconditional last resort was a hole: the one task nobody permitted
   * landed on the daemon's machine, which is exactly what the policy was
   * written to keep it off. `policy` (the default) hands the decision to that
   * machine's own policy, so a deny-list instance behaves exactly as before.
   */
  private fallbackTarget(task: string | null): 'local' | 'refuse' {
    const mode = this.instancePolicy.fallback?.() ?? 'policy';
    if (mode === 'local') return 'local';
    if (mode === 'refuse') return 'refuse';
    const local = this.store.runners.get(LOCAL_RUNNER_ID);
    return local && local.enabled === 1 && this.allows(local, task) ? 'local' : 'refuse';
  }

  /** Names what rejected the run, and the two ways an operator can change it. */
  private refusalMessage(why: string): string {
    const local = this.store.runners.get(LOCAL_RUNNER_ID);
    const here =
      this.instancePolicy.fallback?.() === 'refuse'
        ? "and this instance does not fall back to the daemon's machine"
        : `and ${local?.name ?? "the daemon's machine"} does not take it either (${local?.task_policy_mode ?? 'deny'}-list${local?.enabled === 0 ? ', switched off' : ''})`;
    return `${why}, ${here}. Allow it on a machine under Runners, or change Operate's "work no machine accepts" setting.`;
  }

  /**
   * Combined concurrent-run capacity across every enabled, online runner the
   * caller can place on — the ceiling the orchestrator schedules against.
   * Personally-owned runners only count toward their owner's capacity
   * (`userId`); the shared pool (automation, the queue pump) excludes them.
   * The local runner always counts, so this is at least its cap. With `task`,
   * only runners whose policy accepts it count (chat-slot gating).
   *
   * Deliberately blind to repository clearance: this is a pool ceiling with no
   * repo in hand, so a repo-scoped machine is counted rather than guessed away
   * — an over-approximation that keeps the queue pumping at full width.
   */
  totalCapacity(userId: string | null = null, task: string | null = null): number {
    let sum = 0;
    for (const row of this.store.runners.list()) {
      if (row.owner_id !== null && row.owner_id !== userId) continue;
      if (!this.allows(row, task)) continue;
      if (!this.servesRole(row, userId)) continue;
      if (row.enabled === 1 && this.isOnline(row)) sum += Math.max(0, row.max_runs);
    }
    return sum;
  }

  /**
   * Runner ids whose task policy accepts this task; null for an unlabeled run,
   * which every machine accepts. The chat-slot gate counts against this rather
   * than re-implementing the policy in SQL — one definition, one place.
   */
  runnersAllowing(task: string | null): string[] | null {
    if (task === null) return null;
    return this.store.runners
      .list()
      .filter((row) => this.allows(row, task))
      .map((row) => row.id);
  }

  /** Occupancy of the pool this user can schedule against: shared + their own. */
  capacitySnapshot(userId: string | null = null): { active: number; capacity: number } {
    const counts = this.store.runs.activeCountsByRunner();
    let active = 0;
    let capacity = 0;
    for (const row of this.store.runners.list()) {
      if (row.owner_id !== null && row.owner_id !== userId) continue;
      if (row.enabled !== 1 || !this.isOnline(row)) continue;
      capacity += Math.max(0, row.max_runs);
      active += this.activeRuns(row, counts);
    }
    return { active, capacity: Math.max(1, capacity) };
  }

  /**
   * Whether an eligible, healthy runner could take this task right now.
   *
   * A task NO machine may run is not a capacity answer, so it reports true:
   * the caller then dispatches and fails with the policy refusal from
   * `place()`, instead of parking the work in a "waiting for a slot" state
   * that never clears. Only genuine saturation returns false.
   */
  hasFreeCapacity(repo: string | null, task: string | null, userId: string | null = null): boolean {
    const workspaceId = repo ? (this.store.repos.get(repo)?.workspace_id ?? null) : null;
    const counts = this.store.runs.activeCountsByRunner();
    const eligible = this.store.runners
      .eligibleFor(workspaceId, userId)
      .filter((row) => this.allows(row, task))
      .filter((row) => this.servesRepo(row, repo))
      .filter((row) => this.servesRole(row, userId))
      .filter((row) => this.isOnline(row) && this.hasReadyProvider(row));
    if (eligible.length === 0) {
      if (this.fallbackTarget(task) === 'refuse') return true;
      const local = this.store.runners.get(LOCAL_RUNNER_ID);
      return local !== undefined && this.activeRuns(local, counts) < Math.max(1, local.max_runs);
    }
    return eligible.some((row) => this.activeRuns(row, counts) < Math.max(1, row.max_runs));
  }

  /** Reconcile persisted assignments with backend/reported liveness. */
  private activeRuns(row: RunnerRow, counts: ReadonlyMap<string | null, number>): number {
    const assigned = counts.get(row.id === LOCAL_RUNNER_ID ? null : row.id) ?? 0;
    const tracked = this.backend(row.id).liveIds().length;
    const reported = this.health.get(row.id)?.liveRuns ?? 0;
    return Math.max(assigned, tracked, reported);
  }

  private isOnline(row: RunnerRow): boolean {
    const health = this.health.get(row.id);
    // Remote capacity is counted only after a successful, protocol-compatible
    // probe. The in-process local runner remains available during startup.
    if (!health || health.status === 'unknown') return row.id === LOCAL_RUNNER_ID;
    return health.status === 'online';
  }

  /**
   * Why a machine cannot take this work, or null when it can.
   *
   * A lane names a machine BY CHOICE, and a choice that cannot be honoured has
   * to say so where it was made. Placing elsewhere would make the selection a
   * lie, and running there anyway would override the machine's own refusal,
   * which a preference is never allowed to do.
   */
  refusalFor(runnerId: string | null, opts: { task?: string | null; repo?: string | null; userId?: string | null } = {}): string | null {
    const row = this.store.runners.get(runnerId ?? LOCAL_RUNNER_ID);
    if (!row) return 'that machine is no longer connected';
    if (row.enabled !== 1) return `${row.name} is disabled`;
    if (!this.allows(row, opts.task ?? null)) return `${row.name} does not accept ${opts.task ?? 'this work'}`;
    if (!this.servesRepo(row, opts.repo ?? null)) return `${row.name} is not cleared for this repository`;
    if (!this.servesRole(row, opts.userId ?? null)) return `${row.name} is not available to your role`;
    return null;
  }

  /** True when this machine's task policy accepts the task (null task = always). */
  private allows(row: RunnerRow, task: string | null): boolean {
    return task === null || taskPolicyAllows(taskPolicyOf(row), task);
  }

  /**
   * True when the machine is cleared for this repository. A machine limited to
   * selected repos takes only their work: repo-less runs (chats, digests) have
   * no clearance to match, so they are placed elsewhere.
   */
  private servesRepo(row: RunnerRow, repo: string | null): boolean {
    return row.repo_scope !== 'selected' || (repo !== null && row.repo_ids.includes(repo));
  }

  /**
   * True when the triggering user's role may use this machine. Automated work
   * has no triggering role, so a role-restricted machine never receives it —
   * "only these roles" would otherwise be silently wider than it reads.
   */
  private servesRole(row: RunnerRow, userId: string | null): boolean {
    if (row.allowed_roles.length === 0) return true;
    if (userId === null) return false;
    const role = this.instancePolicy.roleOf?.(userId) ?? null;
    return role !== null && row.allowed_roles.includes(role);
  }

  /** Store null for the local runner so existing rows/queries stay simple. */
  private normalize(id: string): string | null {
    return id === LOCAL_RUNNER_ID ? null : id;
  }

  // ---------- health ----------

  private async pollHealth(): Promise<void> {
    // Parallel: one hanging machine must not delay every other runner's health.
    await Promise.all(
      [...this.backends.keys()].map((id) =>
        this.probeOne(id).catch((err) => log.warn('runner health probe failed', { runner: id, err: String(err) })),
      ),
    );
    await this.refreshStalestCatalog();
  }

  /**
   * One stale machine per poll tick — that's what makes the catalog current
   * without anyone clicking, and the drip keeps a whole fleet from spawning
   * probe sessions at once (each probe starts the runtime it is reading).
   */
  private async refreshStalestCatalog(): Promise<void> {
    const now = Date.now();
    const due = this.store.runners
      .list()
      .filter((row) => row.enabled === 1 && this.isOnline(row) && this.catalogStale(row, now))
      .sort((a, b) => (a.catalog?.fetchedAt ?? 0) - (b.catalog?.fetchedAt ?? 0))[0];
    if (due) await this.refreshCatalog(due.id).catch(() => undefined);
  }

  private catalogStale(row: RunnerRow, now = Date.now()): boolean {
    return !row.catalog || now - row.catalog.fetchedAt > CATALOG_TTL_MS;
  }

  healthFor(id: string): RunnerHealth {
    return this.health.get(id) ?? UNKNOWN_HEALTH;
  }

  /** Companion owns retention; runners only execute it inside their managed
   * roots. Every registered compatible machine receives the same policy and
   * the run leases that protect active/review work. */
  private async enforceStorageCleanup(): Promise<void> {
    await Promise.all([...this.backends.keys()].map((id) => this.cleanupOne(id)));
  }

  private async cleanupOne(id: string): Promise<void> {
    if (this.cleanupInFlight.has(id)) return;
    const health = this.health.get(id);
    if (id !== LOCAL_RUNNER_ID && (!health || health.status === 'offline' || health.status === 'unknown' || health.agentOutdated)) {
      return;
    }
    this.cleanupInFlight.add(id);
    try {
      const policy = this.storagePolicy();
      const since = Date.now() - Math.max(policy.worktreeRetentionMs, policy.scratchRetentionMs, policy.sessionRetentionMs);
      const runs = this.store.runs.storageLeasesForRunner(id === LOCAL_RUNNER_ID ? null : id, since);
      const result = await this.backends.get(id)!.cleanupStorage({ ...policy, runs });
      const removed =
        result.removedWorktrees + result.removedScratchDirs + result.removedSessionFiles + result.removedRunConfigs;
      if (removed > 0) {
        log.info('runner storage cleanup completed', {
          runner: id,
          worktrees: result.removedWorktrees,
          scratch: result.removedScratchDirs,
          sessions: result.removedSessionFiles,
          configs: result.removedRunConfigs,
        });
      }
      if (result.errors.length > 0) log.warn('runner storage cleanup had errors', { runner: id, errors: result.errors });
    } catch (err) {
      log.warn('runner storage cleanup failed', { runner: id, err: String(err) });
    } finally {
      this.cleanupInFlight.delete(id);
    }
  }

  // ---------- CRUD (drives store + backend rebuild) ----------

  list(): RunnerRecord[] {
    return this.store.runners.list().map((r) => this.toRecord(r));
  }

  get(id: string): RunnerRecord | undefined {
    const row = this.store.runners.get(id);
    return row ? this.toRecord(row) : undefined;
  }

  async create(req: CreateRunnerRequest, ownerId: string | null): Promise<RunnerRecord> {
    const id = `runner-${randomUUID().slice(0, 12)}`;
    this.store.runners.insert({
      id,
      name: req.name,
      kind: 'remote',
      endpoint: req.endpoint.replace(/\/+$/, ''),
      token: req.token,
      scope: req.scope ?? 'shared',
      ownerId,
      maxRuns: req.maxRuns ?? 3,
      workspaceIds: req.workspaceIds ?? [],
      taskPolicy: req.taskPolicy,
    });
    this.rebuildRemotes();
    await this.probeOne(id);
    // Binding a machine attaches its models straight away — nobody should have
    // to go fetch them before pinning one.
    await this.refreshCatalog(id, true);
    this.broadcast({ t: 'runners.changed' });
    return this.get(id)!;
  }

  async update(id: string, req: UpdateRunnerRequest): Promise<RunnerRecord> {
    const row = this.store.runners.get(id);
    if (!row) throw new Error('runner not found');
    // Capacity, reach and policy apply to the local runner too — only its
    // connection fields are meaningless there (it has no endpoint or token).
    const reach = {
      name: req.name,
      maxRuns: req.maxRuns,
      scope: req.scope,
      workspaceIds: req.workspaceIds,
      enabled: req.enabled,
      taskPolicy: req.taskPolicy,
      repoScope: req.repoScope,
      repoIds: req.repoIds,
      allowedRoles: req.allowedRoles,
    };
    if (row.kind === 'local') {
      // Only this machine's set is a choice; a remote one runs what its agent
      // can spawn, so accepting a set there would record a lie.
      this.store.runners.update(id, { ...reach, harnesses: req.harnesses });
      if (req.harnesses !== undefined) {
        // The old catalog described a runtime this machine no longer runs.
        // Keeping it until a fresh probe SUCCEEDS is how a machine ends up
        // advertising the previous runtime's models as a credentialed
        // provider, which is exactly what the switch was meant to end.
        this.store.runners.setCatalog(id, null);
        this.rebuildModelIndex();
        this.forgetDetection();
        this.catalogAttempt.delete(id);
        this.catalogInFlight.delete(id);
        await this.refreshCatalog(id, true).catch(() => undefined);
      }
    } else {
      this.store.runners.update(id, {
        ...reach,
        endpoint: req.endpoint === undefined ? undefined : req.endpoint.replace(/\/+$/, ''),
        token: req.token,
      });
      this.rebuildRemotes();
      await this.probeOne(id);
      // A re-pointed machine is a different machine: its old models are stale.
      if (req.endpoint !== undefined || req.token !== undefined) await this.refreshCatalog(id, true);
    }
    if (req.enabled !== undefined) this.rebuildModelIndex();
    this.broadcast({ t: 'runners.changed' });
    return this.get(id)!;
  }

  delete(id: string): void {
    this.store.runners.delete(id);
    const backend = this.backends.get(id);
    if (backend instanceof RemoteRunnerBackend) backend.dispose();
    this.backends.delete(id);
    this.health.delete(id);
    this.catalogAttempt.delete(id);
    this.rebuildModelIndex();
    // Repos pinned to this runner fall back to auto-placement.
    for (const repo of this.store.repos.list()) {
      if (repo.runner_id === id) this.store.repos.setRunner(repo.full_name, null);
    }
    this.broadcast({ t: 'runners.changed' });
  }

  /** The "Test connection" action — only probe machine/runtime health. */
  async probeNow(id: string): Promise<RunnerProbeResult> {
    const health = await this.probeOne(id);
    const ok = health.status === 'online' || health.status === 'degraded';
    this.broadcast({ t: 'runners.changed' });
    return { ok, health, catalog: this.store.runners.get(id)?.catalog ?? null };
  }

  /** True when the runner has a credential-ready provider it is allowed to use. */
  private hasReadyProvider(row: RunnerRow): boolean {
    // A runtime that owns its model access (for example a signed-in CLI) has no
    // provider credential for Companion to validate. Its own readiness probe
    // is the authority; an empty provider catalog is expected, not a refusal.
    if (this.harnessesOn(row)[0]?.capabilities.models === 'builtin') return true;
    const cat = row.catalog;
    // Unknown catalog stays optimistic (never probed yet); an empty/all-unready
    // catalog means the runner can't actually serve anything.
    if (!cat) return true;
    return cat.providers.some((p) => p.ready && !row.disabled_providers.includes(p.name));
  }

  private async probeOne(id: string): Promise<RunnerHealth> {
    const backend = this.backends.get(id);
    if (!backend) return UNKNOWN_HEALTH;
    const prev = this.health.get(id);
    const health = await backend.probe();
    this.health.set(id, health);
    if (JSON.stringify(prev) !== JSON.stringify(health)) this.broadcast({ t: 'runners.changed' });
    // Transition into offline strands the runs placed there — tell the sink so
    // they're marked interrupted (and their owners can redispatch) instead of
    // sitting "live" forever on a machine that's gone.
    if (prev?.status !== 'offline' && health.status === 'offline' && id !== LOCAL_RUNNER_ID) {
      this.sink.onRunnerUnreachable(id, health.detail ?? 'runner unreachable');
    }
    const newlyReachable =
      id !== LOCAL_RUNNER_ID &&
      (prev === undefined || prev.status === 'offline' || prev.status === 'unknown') &&
      health.status !== 'offline' &&
      health.status !== 'unknown' &&
      !health.agentOutdated;
    if (newlyReachable) {
      void this.cleanupOne(id);
      // Only when it had actually been reported gone: a machine registered and
      // probed for the first time is not a recovery, and announcing it as one
      // would post about every new runner.
      if (prev?.status === 'offline') this.sink.onRunnerReachable(id);
    }
    return health;
  }

  /** Nudge health after an external failure signal (e.g. a spawn that died). */
  recheckHealth(id: string | null): void {
    void this.probeOne(id ?? LOCAL_RUNNER_ID).catch(() => undefined);
  }

  private toRecord(row: RunnerRow): RunnerRecord {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      endpoint: row.endpoint,
      hasToken: Boolean(row.token),
      ownerId: row.owner_id,
      scope: row.scope,
      workspaceIds: row.workspace_ids,
      maxRuns: row.max_runs,
      enabled: row.enabled === 1,
      taskPolicy: taskPolicyOf(row),
      repoScope: row.repo_scope,
      repoIds: row.repo_ids,
      allowedRoles: row.allowed_roles,
      health: this.healthFor(row.id),
      harnesses: this.harnessesOn(row),
      catalog: row.catalog,
      providerPolicy: { disabledProviders: row.disabled_providers, disabledModels: row.disabled_models },
      createdAt: row.created_at,
    };
  }

  /**
   * The agent runtimes a machine runs work through, in preference order. Only
   * the local machine can be set to anything else: the runner agent protocol
   * carries moxxy-shaped calls, so a remote machine runs moxxy whatever its row
   * says.
   */
  private harnessesOn(row: RunnerRow): readonly HarnessDescriptor[] {
    return row.kind === 'local' ? harnessSet(row.harnesses) : [MOXXY_HARNESS];
  }

  /**
   * What is installed on this machine, cached.
   *
   * Detection shells out twice per runtime (is it there, and is it usable), and
   * both callers are hot in their own way: the health poller asks every thirty
   * seconds and the settings page asks on every visit. The answer changes only
   * when software is installed or signed into, so a short cache costs nothing
   * and a stale minute costs less than a fistful of processes per page view.
   */
  private async detected(): Promise<readonly HarnessDetection[]> {
    const now = Date.now();
    if (this.detectedAt + DETECT_TTL_MS > now && this.detectedHarnesses) return this.detectedHarnesses;
    this.detectedAt = now;
    this.detectedHarnesses = await detectHarnesses(paths.moxxyHome());
    return this.detectedHarnesses;
  }

  /** Forget the cache: something that changes what is installed just happened. */
  private forgetDetection(): void {
    this.detectedAt = 0;
  }

  /**
   * Models one lane can actually serve.
   *
   * Scoped by runtime, not just by machine: a runtime that signs in on its own
   * serves ONLY its own models, and one that reads providers serves everything
   * except those. Offering a lane a model its runtime cannot run is the exact
   * trap this exists to close, because the pin would be dropped at dispatch and
   * nobody would be told why.
   */
  modelsForLane(runnerId: string | null, harness: string | null): CatalogModel[] {
    const row = this.store.runners.get(runnerId ?? LOCAL_RUNNER_ID);
    if (!row) return [];
    const policy = policyOf(row);
    const builtin = new Set(
      this.harnessesOn(row)
        .filter((h) => h.capabilities.models === 'builtin')
        .map((h) => h.id),
    );
    const wanted = harness !== null && builtin.has(harness) ? (name: string) => name === harness : (name: string) => !builtin.has(name);
    const out: CatalogModel[] = [];
    for (const provider of this.providersOn(row)) {
      if (!provider.ready || policy.providers.has(provider.name) || !wanted(provider.name)) continue;
      for (const model of provider.models) {
        if (!modelAllowed(policy, provider.name, model.id)) continue;
        out.push({ id: model.id, contextWindow: model.contextWindow, machines: [row.id] });
      }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * A machine's providers: the probed ones from its stored catalog, plus what
   * its built-in runtimes offer, computed now.
   *
   * The stored catalog caches what is expensive to learn — asking a
   * provider-backed runtime which credentials actually work. What a runtime
   * that ships its own models offers costs a descriptor lookup or a file read,
   * so caching it bought nothing and cost correctness: such a runtime stayed
   * invisible until the catalog's six-hour TTL expired, which is how installing
   * Codex left it with no models for the rest of the afternoon.
   */
  private providersOn(row: RunnerRow): RunnerCatalog['providers'] {
    const builtin = this.harnessesOn(row).flatMap((h) => builtinCatalog(h)?.providers ?? []);
    if (builtin.length === 0) return row.catalog?.providers ?? [];
    const fresh = new Set(builtin.map((p) => p.name));
    return [...(row.catalog?.providers ?? []).filter((p) => !fresh.has(p.name)), ...builtin];
  }

  /** Runtimes a machine is set up to run, so a lane's choice can be checked. */
  harnessIdsOn(runnerId: string | null): readonly string[] {
    const row = this.store.runners.get(runnerId ?? LOCAL_RUNNER_ID);
    return row ? this.harnessesOn(row).map((h) => h.id) : [MOXXY_HARNESS.id];
  }

  /** The harness a run placed here starts under: the machine's first choice. */
  harnessFor(runnerId: string | null): HarnessDescriptor {
    const row = this.store.runners.get(runnerId ?? LOCAL_RUNNER_ID);
    return (row ? this.harnessesOn(row)[0] : undefined) ?? MOXXY_HARNESS;
  }

  /**
   * What the local backend should start for a run id. Work with no run row is a
   * catalog probe: it must read the harness this machine actually runs, or the
   * machine would report another one's models.
   */
  private localRunSpec(runId: string): LocalRunSpec {
    const row = this.store.runs.get(runId);
    if (!row) return { harness: this.harnessFor(LOCAL_RUNNER_ID).id, model: null };
    return { harness: row.harness, model: row.model };
  }

  /**
   * What this machine could be set to run, and what it is set to run now.
   * Harnesses that are not installed are left out entirely rather than listed
   * as unavailable, so the list is exactly as long as the machine's real
   * options.
   */
  async harnessOptions(id: string): Promise<HarnessOptions> {
    const row = this.store.runners.get(id);
    if (!row) throw new Error('runner not found');
    const selected = this.harnessesOn(row).map((h) => h.id);
    if (row.kind !== 'local') return { options: [MOXXY_OPTION], selected };
    return { options: offeredHarnesses(await this.detected()), selected };
  }

  // ---------- catalogs: the one source of provider/model truth ----------

  /**
   * A machine's models, fetched if the cached copy is missing or past its TTL.
   * Concurrent callers share one probe, and a failed probe backs off — this is
   * the only entry point, so no caller can stampede a machine.
   */
  async refreshCatalog(id: string, force = false): Promise<RunnerCatalog | null> {
    const row = this.store.runners.get(id);
    if (!row) return null;
    const now = Date.now();
    if (!force && !this.catalogStale(row, now)) return row.catalog;
    const inFlight = this.catalogInFlight.get(id);
    if (inFlight) return inFlight;
    if (!force && now - (this.catalogAttempt.get(id) ?? 0) < CATALOG_RETRY_MS) return row.catalog;
    this.catalogAttempt.set(id, now);
    const job = this.probeCatalog(id).finally(() => this.catalogInFlight.delete(id));
    this.catalogInFlight.set(id, job);
    return job;
  }

  /**
   * Every online machine the viewer can use, at once. `force` is the page's
   * explicit Refresh; unforced it respects the TTL and the failure backoff, so
   * calling it on a page load costs nothing when catalogs are current. Each
   * probe starts a short-lived runtime session on someone's machine, so it stays scoped the
   * same way the page is: shared machines plus the viewer's own.
   */
  async refreshAllCatalogs(force = true, userId: string | null = null): Promise<void> {
    const rows = this.visibleTo(userId).filter((row) => row.enabled === 1 && this.isOnline(row));
    await Promise.all(rows.map((row) => this.refreshCatalog(row.id, force).catch(() => undefined)));
  }

  /**
   * Free refresh off a gateway that is already up for a real run — no probe
   * process. Never clears a known catalog: an empty answer here means the
   * session couldn't report, not that the machine lost its providers.
   */
  noteLiveSession(runnerId: string | null, runId: string): void {
    const id = runnerId ?? LOCAL_RUNNER_ID;
    if (!this.catalogDue(id)) return;
    // `.catch` cannot cover a synchronous throw, and the local backend does
    // throw one: `sessionInfo` is declared to return a promise but reaches the
    // gateway through a lookup that raises when the run has none. Without this,
    // a free catalog top-up fails the run it was riding along with.
    try {
      void this.backends
        .get(id)
        ?.sessionInfo(runId)
        .then((info) => this.noteSessionInfo(runnerId, info, this.store.runs.get(runId)?.harness))
        .catch(() => undefined);
    } catch {
      // Best effort by definition: the catalog stays as it was.
    }
  }

  /** Same, for session info a caller already holds — costs one parse. */
  noteSessionInfo(runnerId: string | null, info: unknown, harnessId?: string): void {
    const id = runnerId ?? LOCAL_RUNNER_ID;
    if (!this.catalogDue(id)) return;
    // Built-in runtimes expose their models through their descriptor/cache.
    // Persisting that session-shaped answer would replace the provider catalog
    // of another selected runtime on the same machine.
    if (harnessId && describeHarness(harnessId).capabilities.models !== 'providers') return;
    const catalog = parseCatalog(info as SessionInfo);
    if (catalog.providers.length > 0) this.storeCatalog(id, catalog);
  }

  private catalogDue(id: string): boolean {
    const row = this.store.runners.get(id);
    return row !== undefined && this.catalogStale(row);
  }

  /**
   * One group per machine (its own catalog and its own policy) plus the merged
   * effective set: a model shows up once, carrying the machines that may serve
   * it. The merge is what a per-machine page cannot answer ("can agents use
   * model X at all"), so it lists only what is ready AND enabled somewhere.
   * A provider exists here only when a selected runtime reports it. This keeps
   * adapter-owned configuration out of the generic registry.
   */
  catalogSnapshot(userId: string | null = null): ProviderCatalog {
    const rows = this.visibleTo(userId).filter((row) => row.enabled === 1);
    const providers = new Map<
      string,
      { machines: Set<string>; disabledOn: Set<string>; models: Map<string, CatalogModel> }
    >();
    const entry = (name: string) => {
      let found = providers.get(name);
      if (!found) providers.set(name, (found = { machines: new Set(), disabledOn: new Set(), models: new Map() }));
      return found;
    };
    const machines: CatalogMachine[] = [];
    let fetchedAt: number | null = null;
    for (const row of rows) {
      const policy = policyOf(row);
      const servable = new Set<string>();
      const groups: CatalogMachineProvider[] = [];
      // A machine whose runtimes bring their own models has a catalog, and it
      // is not a provider catalog: folding it into the merged set would invent
      // a provider nobody has credentials for and make an instance that runs
      // only such machines read as configured.
      //
      // A machine running BOTH kinds answers the provider question, so its
      // groups list the built-in runtime's models too (they are real models it
      // serves) while that runtime still stays out of the merged set, which is
      // about credentials.
      const harnesses = this.harnessesOn(row);
      const fromProviders = servesProviderModels(harnesses);
      const builtinProviders = new Set(
        harnesses.filter((h) => h.capabilities.models === 'builtin').map((h) => h.id),
      );
      for (const provider of fromProviders ? this.providersOn(row) : []) {
        // A runtime that carries its own models needs no credential, so it gets
        // no entry in the merged view — but it is still a real group on this
        // machine, and its models still count towards what the machine serves.
        const merged = builtinProviders.has(provider.name) ? null : entry(provider.name);
        const providerEnabled = !policy.providers.has(provider.name);
        const models = provider.models.map((model): CatalogMachineModel => ({
          id: model.id,
          contextWindow: model.contextWindow,
          enabled: modelAllowed(policy, provider.name, model.id),
        }));
        groups.push({ name: provider.name, ready: provider.ready, enabled: providerEnabled, models });
        // Only a credential-ready provider the machine still allows contributes
        // to the merged set: listing models no machine can actually serve is
        // what made the old page misleading.
        if (!provider.ready) continue;
        if (!providerEnabled) {
          merged?.disabledOn.add(row.id);
          continue;
        }
        merged?.machines.add(row.id);
        for (const model of models) {
          if (!model.enabled) continue;
          servable.add(model.id);
          if (!merged) continue;
          const existing = merged.models.get(model.id);
          merged.models.set(model.id, {
            id: model.id,
            contextWindow: model.contextWindow ?? existing?.contextWindow ?? null,
            machines: [...(existing?.machines ?? []), row.id],
          });
        }
      }
      const at = row.catalog?.fetchedAt ?? null;
      if (at !== null) fetchedAt = Math.max(fetchedAt ?? 0, at);
      machines.push({
        id: row.id,
        name: row.name,
        online: this.isOnline(row),
        fetchedAt: at,
        modelCount: servable.size,
        providerModels: fromProviders,
        providers: groups,
        policy: { disabledProviders: row.disabled_providers, disabledModels: row.disabled_models },
      });
    }

    return {
      providers: [...providers.entries()]
        .map(([name, merged]): CatalogProvider => ({
          name,
          machines: [...merged.machines],
          disabledOn: [...merged.disabledOn],
          models: [...merged.models.values()].sort((a, b) => a.id.localeCompare(b.id)),
        }))
        .sort((a, b) => b.models.length - a.models.length || a.name.localeCompare(b.name)),
      machines,
      fetchedAt,
    };
  }

  /**
   * Every model some enabled SHARED machine is CAPABLE of serving, deduplicated
   * across providers and machines.
   *
   * Read from the machines' own catalogs rather than from the merged provider
   * view, because those answer different questions. The merged view is about
   * CREDENTIALS: a runtime that carries its own models is left out of it, or
   * the Providers page would invent a provider nobody has to configure. This
   * one is about CAPABILITY, and a machine running Claude Code really can serve
   * `opus`. Deriving this from that view is why a runtime's own models could
   * not be pinned to a task at all.
   *
   * This is what an instance-wide task pin may be set to. Capability only: a
   * machine that is offline right now, or blocks the task, still counts, because
   * both are transient placement facts and a pin outlives them. Where a pin
   * cannot be honoured the run falls back to that machine's default rather than
   * failing (see Orchestrator.servablePin).
   *
   * Personal machines are deliberately excluded: automation and other people's
   * runs never place there, so a pin only they could serve would never apply to
   * the work it was set for. Their extra models stay reachable per run, where
   * the choice belongs to whoever can actually reach the machine.
   */
  servableModels(): CatalogModel[] {
    const merged = new Map<string, CatalogModel>();
    for (const row of this.visibleTo(null)) {
      if (row.enabled !== 1) continue;
      const policy = policyOf(row);
      for (const provider of this.providersOn(row)) {
        // The same two rules the merged view applies, restated here because
        // this walks the rows: an unready provider serves nothing, and a
        // machine's own policy decides what it will serve.
        if (!provider.ready || policy.providers.has(provider.name)) continue;
        for (const model of provider.models) {
          if (!modelAllowed(policy, provider.name, model.id)) continue;
          const seen = merged.get(model.id);
          merged.set(model.id, {
            id: model.id,
            contextWindow: model.contextWindow ?? seen?.contextWindow ?? null,
            machines: [...new Set([...(seen?.machines ?? []), row.id])],
          });
        }
      }
    }
    return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Repositories a machine can be cleared for. Read through the store facade's
   * guarded repos view, so an instance without module-code simply offers none
   * rather than failing the settings page.
   */
  repoOptions(): RunnerRepoRef[] {
    return this.store.repos
      .list()
      .map((row) => ({ fullName: row.full_name, workspaceId: row.workspace_id }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName));
  }

  /** Shared machines plus the viewer's own, never another user's private one. */
  private visibleTo(userId: string | null): RunnerRow[] {
    return this.store.runners.list().filter((row) => row.owner_id === null || row.owner_id === userId);
  }

  /** Replace one machine's provider policy (full replacement; empty allows all). */
  setProviderPolicy(id: string, policy: RunnerProviderPolicy): void {
    this.store.runners.setProviderPolicy(id, policy);
    this.rebuildModelIndex();
    this.broadcast({ t: 'runners.changed' });
  }

  /** One machine's policy as lookup sets, for filtering a live model catalog. */
  policyFor(runnerId: string | null): RunnerPolicy {
    return policyOf(this.store.runners.get(runnerId ?? LOCAL_RUNNER_ID));
  }

  /**
   * Runners that may run `model` right now: enabled runner, credential-ready
   * provider, and neither the provider nor the model switched off there. Null
   * means no machine's catalog mentions the model at all, so nothing can be
   * proven about it; an empty set means it is known and allowed nowhere.
   */
  runnersForModel(model: string | null): ReadonlySet<string> | null {
    return model ? (this.modelServers.get(model) ?? null) : null;
  }

  /**
   * May `runnerId` run `model`? False only on evidence: some machine's catalog
   * lists the model and this machine, which has reported its own catalog, does
   * not allow it. Unknowns stay permissive, so a machine that has never been
   * probed is never refused for a model it might well serve.
   */
  serves(runnerId: string | null, model: string | null): boolean {
    const servers = this.runnersForModel(model);
    if (!servers) return true;
    const row = this.store.runners.get(runnerId ?? LOCAL_RUNNER_ID);
    return row === undefined || rowServes(row, servers);
  }

  /**
   * Fetch a runner's provider/model catalog through every configured runtime
   * that reports provider-backed models. Heavier than a health
   * probe — go through refreshCatalog, which dedupes and backs off.
   */
  private async probeCatalog(id: string): Promise<RunnerCatalog | null> {
    const backend = this.backends.get(id);
    if (!backend) return null;
    const row = this.store.runners.get(id);
    const harnesses = row ? this.harnessesOn(row) : [this.harnessFor(id)];

    // A machine may be set to run SEVERAL runtimes, and its catalog is the union
    // of what they serve. Asking only the first one previously hid every
    // provider reported by the remaining runtimes.
    //
    // A runtime that ships its own models already told us what they are, so it
    // contributes without a process; only the ones that answer from configured
    // providers are worth the probe.
    const probed = harnesses.some((harness) => harness.capabilities.models === 'providers');
    if (!probed) {
      // Nothing here answers from configured credentials, so there is nothing
      // to probe. Its models are merged in on read.
      const catalog: RunnerCatalog = { providers: [], defaultModel: null, fetchedAt: Date.now() };
      this.storeCatalog(id, catalog);
      return catalog;
    }

    const catalogs: RunnerCatalog[] = [];
    for (const harness of harnesses.filter((candidate) => candidate.capabilities.models === 'providers')) {
      try {
        catalogs.push(parseCatalog((await backend.probeRuntime(harness.id)) as SessionInfo));
      } catch (err) {
        log.warn('runtime catalog probe failed', { runner: id, runtime: harness.id, err: String(err) });
      }
    }
    if (catalogs.length === 0) return this.store.runners.get(id)?.catalog ?? null;
    const catalog = mergeCatalogs(catalogs);
    this.storeCatalog(id, catalog);
    return catalog;
  }

  private storeCatalog(id: string, catalog: RunnerCatalog): void {
    this.store.runners.setCatalog(id, catalog);
    this.rebuildModelIndex();
    this.broadcast({ t: 'runners.changed' });
  }

  /**
   * Rebuild the model → runners map. Every model any catalog lists gets a key
   * (that is how callers tell "unknown model" from "allowed nowhere"), but only
   * machines that would actually run it are recorded. O(models across
   * catalogs); small data, rebuilt only on writes.
   *
   * Deliberately blind to `enabled`: that switch governs PLACEMENT (see
   * `eligibleFor`), not whether a machine may answer. Folding it in here would
   * make disabling a machine break the turns of runs already live on it.
   */
  private rebuildModelIndex(): void {
    const index = new Map<string, Set<string>>();
    for (const row of this.store.runners.list()) {
      const policy = policyOf(row);
      for (const provider of this.providersOn(row)) {
        const usable = provider.ready && !policy.providers.has(provider.name);
        for (const model of provider.models) {
          const allowed = usable && modelAllowed(policy, provider.name, model.id);
          for (const key of [model.id, `${provider.name}/${model.id}`]) {
            let servers = index.get(key);
            if (!servers) index.set(key, (servers = new Set()));
            if (allowed) servers.add(row.id);
          }
        }
      }
    }
    this.modelServers = index;
  }
}

/** A runner's own provider policy as lookup sets (empty = allows everything). */
export interface RunnerPolicy {
  readonly providers: ReadonlySet<string>;
  readonly models: ReadonlySet<string>;
}

function policyOf(row: RunnerRow | undefined): RunnerPolicy {
  return { providers: new Set(row?.disabled_providers ?? []), models: new Set(row?.disabled_models ?? []) };
}

/** The stored columns as the contract's policy shape (the form both sides read). */
function taskPolicyOf(row: RunnerRow): RunnerTaskPolicy {
  return { mode: row.task_policy_mode, modules: row.policy_modules, tasks: row.policy_tasks };
}

/** Model ids are stored bare (`opus`) or provider-scoped (`anthropic/opus`). */
function modelAllowed(policy: RunnerPolicy, provider: string, id: string): boolean {
  return !policy.models.has(id) && !policy.models.has(`${provider}/${id}`);
}

/**
 * Row-level form of `Runners.serves`, for callers that already hold the row
 * (placement walks every candidate, so it must not re-query per runner). A
 * machine that has never reported a catalog stays optimistic.
 */
function rowServes(row: RunnerRow, servers: ReadonlySet<string> | null): boolean {
  return !servers || servers.has(row.id) || row.catalog === null;
}

type SessionInfo = { activeProvider?: unknown; providers?: unknown; readyProviders?: unknown } | null;

/** Parse the normalized session-info surface into a per-runner catalog. */
function parseCatalog(info: SessionInfo): RunnerCatalog {
  // Readiness gates placement AND what the catalog shows. A moxxy build that
  // doesn't report the field at all leaves it unknown — fall back to `enabled`
  // rather than declaring every machine credential-less now that catalogs are
  // fetched for everyone, not only when someone asked.
  const reportsReadiness = Array.isArray(info?.readyProviders);
  const ready = new Set(
    reportsReadiness ? (info!.readyProviders as unknown[]).filter((p): p is string => typeof p === 'string') : [],
  );
  const providers: ModelCatalogProvider[] = (Array.isArray(info?.providers) ? info!.providers : [])
    .map((raw): ModelCatalogProvider | null => {
      const p = raw as { name?: unknown; models?: unknown; enabled?: unknown };
      if (typeof p.name !== 'string') return null;
      const models: ModelCatalogModel[] = (Array.isArray(p.models) ? p.models : [])
        .map((m): ModelCatalogModel | null => {
          if (typeof m === 'string') return { id: m, contextWindow: null };
          const o = m as { id?: unknown; contextWindow?: unknown };
          return typeof o.id === 'string'
            ? { id: o.id, contextWindow: typeof o.contextWindow === 'number' ? o.contextWindow : null }
            : null;
        })
        .filter((m): m is ModelCatalogModel => m !== null);
      const enabled = p.enabled !== false;
      return { name: p.name, enabled, ready: reportsReadiness ? ready.has(p.name) : enabled, models };
    })
    .filter((p): p is ModelCatalogProvider => p !== null);
  const active = typeof info?.activeProvider === 'string' ? info.activeProvider : null;
  const defaultModel = providers.find((p) => p.name === active)?.models[0]?.id ?? null;
  return { providers, defaultModel, fetchedAt: Date.now() };
}

/** Union provider reports from every provider-backed runtime on a machine. */
function mergeCatalogs(catalogs: readonly RunnerCatalog[]): RunnerCatalog {
  const providers = new Map<string, ModelCatalogProvider>();
  for (const catalog of catalogs) {
    for (const provider of catalog.providers) {
      const previous = providers.get(provider.name);
      if (!previous) {
        providers.set(provider.name, provider);
        continue;
      }
      const models = new Map(previous.models.map((model) => [model.id, model]));
      for (const model of provider.models) models.set(model.id, model);
      providers.set(provider.name, {
        name: provider.name,
        enabled: previous.enabled || provider.enabled,
        ready: previous.ready || provider.ready,
        models: [...models.values()],
      });
    }
  }
  return {
    providers: [...providers.values()],
    defaultModel: catalogs.find((catalog) => catalog.defaultModel !== null)?.defaultModel ?? null,
    fetchedAt: Date.now(),
  };
}
