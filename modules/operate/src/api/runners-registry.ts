import { randomUUID } from 'node:crypto';
import type { SpaServerMessage } from '@moxxy/companion-contracts';
import type { AgentStorageCleanupRequest } from '@companion/types';
import type {
  CatalogMachine,
  CatalogModel,
  CatalogProvider,
  CreateRunnerRequest,
  GitCredentialResolver,
  ModelCatalogModel,
  ModelCatalogProvider,
  ProviderCatalog,
  RunnerCatalog,
  RunnerHealth,
  RunnerPinnableKind,
  RunnerMoxxyUpdateResult,
  RunnerProbeResult,
  RunnerRecord,
  UpdateRunnerRequest,
} from '../contract/index.js';
import { log } from '@companion/services';
import type { OperateStore } from './operate-store.js';
import { LOCAL_RUNNER_ID, type RunnerRow } from './runners-store.js';
import type { Checkouts } from '../exec/checkouts.js';
import type { MoxxyCli } from '../exec/cli.js';
import { configuredProviderNames } from '../exec/home.js';
import type { RunnerBackend, RunnerEventSink } from './backend.js';
import { LocalRunnerBackend } from './local-backend.js';
import { RemoteRunnerBackend } from './remote-backend.js';

const HEALTH_POLL_MS = 30_000;
const STORAGE_CLEANUP_MS = 6 * 60 * 60_000;
/** How long a machine's fetched catalog is trusted before a background re-probe. */
const CATALOG_TTL_MS = 6 * 60 * 60_000;
/** Backoff after a failed probe so an unreachable machine isn't retried every tick. */
const CATALOG_RETRY_MS = 10 * 60_000;
const UNKNOWN_HEALTH: RunnerHealth = {
  status: 'unknown',
  moxxyVersion: null,
  moxxyCompatible: false,
  liveRuns: 0,
  maxRuns: 0,
  lastSeenAt: null,
  detail: null,
  providers: null,
};

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
   * model id (bare AND `provider/id`) → providers serving it, merged across
   * every machine. Placement resolves a model's providers per run, so it reads
   * this map instead of re-parsing catalog JSON out of SQLite each time.
   */
  private modelProviders = new Map<string, Set<string>>();

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
  ) {
    this.local = new LocalRunnerBackend(
      LOCAL_RUNNER_ID,
      checkouts,
      moxxyCli?.path ?? 'moxxy',
      moxxyCli?.version ?? null,
      moxxyCli?.compatible ?? false,
      maxLiveRuns,
      sink,
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
        new RemoteRunnerBackend(row.id, row.endpoint, row.token, this.sink, this.githubTokenFor, (up) => {
          // Event-stream state is the fastest liveness signal: a drop (or a
          // reconnect) triggers an immediate probe instead of waiting out the
          // poll interval. Once health already says offline, the retry loop's
          // repeated drops stop re-probing.
          if (up || this.health.get(row.id)?.status !== 'offline') void this.probeOne(row.id);
        }),
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
   * Provider capability: runners that advertise ZERO providers can't serve
   * any model and are never chosen (unknown = null stays optimistic). When
   * `wantedProviders` names the providers that can serve the run's model,
   * runners advertising one of them are preferred; if none does, placement
   * falls back to the capability-agnostic choice and the model is reconciled
   * per turn instead (see Orchestrator.sendPrompt).
   *
   * Ownership: `userId` is the triggering user. Their personal runners become
   * eligible AND preferred (their machine, their subscription); other users'
   * runners never are. Automation passes null and rides shared runners only.
   *
   * Task eligibility: a runner never receives a task on its block-list — a
   * hard filter that outranks even the repo pin. When no runner at all
   * accepts `task`, the local runner takes it anyway (the work must land
   * somewhere; same spirit as the everything-offline fallback below). An
   * unlabeled run (`task` null) matches every runner.
   */
  place(
    repo: string | null,
    task: string | null,
    wantedProviders?: readonly string[] | null,
    userId: string | null = null,
    /** Runner row ids to skip — failover after a spawn just failed there. */
    exclude?: ReadonlySet<string>,
  ): string | null {
    const workspaceId = repo ? (this.store.repos.get(repo)?.workspace_id ?? null) : null;
    const eligible = this.store.runners
      .eligibleFor(workspaceId, userId)
      .filter((r) => this.allows(r, task))
      .filter((r) => !exclude?.has(r.id));
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
    const served = (row: RunnerRow): boolean => {
      if (!wantedProviders || wantedProviders.length === 0) return true;
      const cat = row.catalog;
      if (!cat) return true;
      return cat.providers.some((p) => p.ready && wantedProviders.includes(p.name));
    };
    const chosen = usable.find(served) ?? usable[0];
    return this.normalize(chosen?.id ?? LOCAL_RUNNER_ID);
  }

  /**
   * Combined concurrent-run capacity across every enabled, online runner the
   * caller can place on — the ceiling the orchestrator schedules against.
   * Personally-owned runners only count toward their owner's capacity
   * (`userId`); the shared pool (automation, the queue pump) excludes them.
   * The local runner always counts, so this is at least its cap. With `task`,
   * only runners whose block-list accepts it count (chat-slot gating).
   */
  totalCapacity(userId: string | null = null, task: string | null = null): number {
    let sum = 0;
    for (const row of this.store.runners.list()) {
      if (row.owner_id !== null && row.owner_id !== userId) continue;
      if (!this.allows(row, task)) continue;
      if (row.enabled === 1 && this.isOnline(row)) sum += Math.max(0, row.max_runs);
    }
    return sum;
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

  /** Whether an eligible, healthy runner can accept this task right now. */
  hasFreeCapacity(repo: string | null, task: string | null, userId: string | null = null): boolean {
    const workspaceId = repo ? (this.store.repos.get(repo)?.workspace_id ?? null) : null;
    const counts = this.store.runs.activeCountsByRunner();
    const eligible = this.store.runners
      .eligibleFor(workspaceId, userId)
      .filter((row) => this.allows(row, task))
      .filter((row) => this.isOnline(row) && this.hasReadyProvider(row));
    // Task filters never make work impossible: the local runner remains the
    // last resort when every machine blocks this task, matching place().
    const candidates =
      eligible.length > 0 ? eligible : this.store.runners.list().filter((row) => row.id === LOCAL_RUNNER_ID);
    return candidates.some(
      (row) => this.activeRuns(row, counts) < Math.max(1, row.max_runs),
    );
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

  /** True when the task isn't on the runner's block-list (null task = always). */
  private allows(row: RunnerRow, task: string | null): boolean {
    return task === null || !row.blocked_tasks.includes(task);
  }

  /** Advertised providers of a runner (null = unknown); null id = local. */
  providersFor(runnerId: string | null): readonly string[] | null {
    return this.health.get(runnerId ?? LOCAL_RUNNER_ID)?.providers ?? null;
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
   * probe gateways at once (each probe is a real moxxy process).
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
      modelPins: req.modelPins,
      blockedTasks: req.blockedTasks,
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
    if (row.kind === 'local') {
      // Capacity, scope, and per-action model pins apply to the local runner too.
      this.store.runners.update(id, {
        name: req.name,
        maxRuns: req.maxRuns,
        scope: req.scope,
        workspaceIds: req.workspaceIds,
        enabled: req.enabled,
        modelPins: req.modelPins,
        blockedTasks: req.blockedTasks,
      });
    } else {
      this.store.runners.update(id, {
        name: req.name,
        endpoint: req.endpoint === undefined ? undefined : req.endpoint.replace(/\/+$/, ''),
        token: req.token,
        scope: req.scope,
        workspaceIds: req.workspaceIds,
        maxRuns: req.maxRuns,
        enabled: req.enabled,
        modelPins: req.modelPins,
        blockedTasks: req.blockedTasks,
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

  /**
   * Update the moxxy CLI on a REMOTE runner's machine (the local runner goes
   * through OperateService.setMoxxyCli — see the route). A pre-update agent
   * 404s the endpoint; surface that as actionable manual guidance.
   */
  async updateMoxxy(id: string): Promise<RunnerMoxxyUpdateResult> {
    const backend = this.backends.get(id);
    if (!(backend instanceof RemoteRunnerBackend)) throw new Error('runner not found');
    let result;
    try {
      result = await backend.updateMoxxy();
    } catch (err) {
      // A pre-update agent 404s with its own error envelope ("no route: …").
      const msg = String(err instanceof Error ? err.message : err);
      throw /no route|agent 404/.test(msg)
        ? new Error(
            'this runner agent predates remote updates — update it on the machine once (npm i -g @moxxy/companion-runner, then restart it); future updates work from here',
          )
        : err;
    }
    await this.probeOne(id);
    this.broadcast({ t: 'runners.changed' });
    return result;
  }

  /** The "Test connection" action — probe health + fetch the runner's catalog. */
  async probeNow(id: string): Promise<RunnerProbeResult> {
    const health = await this.probeOne(id);
    const ok = health.status === 'online' || health.status === 'degraded';
    // Only bother fetching the (heavier) catalog when the runner is reachable.
    const catalog = ok ? await this.refreshCatalog(id, true) : (this.store.runners.get(id)?.catalog ?? null);
    this.broadcast({ t: 'runners.changed' });
    return { ok, health, catalog };
  }

  /** Resolve the model a run of `kind` should use on `runnerId`: its pin, else its default. */
  modelPinFor(runnerId: string | null, kind: RunnerPinnableKind): string | null {
    const row = this.store.runners.get(runnerId ?? LOCAL_RUNNER_ID);
    return row?.model_pins[kind] ?? row?.catalog?.defaultModel ?? null;
  }

  /** True when the runner has at least one credential-ready provider. */
  private hasReadyProvider(row: RunnerRow): boolean {
    const cat = row.catalog;
    // Unknown catalog stays optimistic (never probed yet); an empty/all-unready
    // catalog means the runner can't actually serve anything.
    if (!cat) return true;
    return cat.providers.some((p) => p.ready);
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
      blockedTasks: row.blocked_tasks,
      health: this.healthFor(row.id),
      catalog: row.catalog,
      modelPins: row.model_pins,
      createdAt: row.created_at,
    };
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
   * Every online machine at once. `force` is the page's explicit Refresh;
   * unforced it respects the TTL and the failure backoff, so calling it on a
   * page load costs nothing when catalogs are current.
   */
  async refreshAllCatalogs(force = true): Promise<void> {
    const rows = this.store.runners.list().filter((row) => row.enabled === 1 && this.isOnline(row));
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
    void this.backends
      .get(id)
      ?.sessionInfo(runId)
      .then((info) => this.noteSessionInfo(runnerId, info))
      .catch(() => undefined);
  }

  /** Same, for session info a caller already holds — costs one parse. */
  noteSessionInfo(runnerId: string | null, info: unknown): void {
    const id = runnerId ?? LOCAL_RUNNER_ID;
    if (!this.catalogDue(id)) return;
    const catalog = parseCatalog(info as SessionInfo);
    if (catalog.providers.length > 0) this.storeCatalog(id, catalog);
  }

  private catalogDue(id: string): boolean {
    const row = this.store.runners.get(id);
    return row !== undefined && this.catalogStale(row);
  }

  /**
   * Every machine's catalog merged into one instance-wide view: a model shows
   * up once, carrying the machines that can serve it. Providers configured in
   * the imported moxxy home but served nowhere are listed with no models, so
   * the page can say *why* instead of going blank.
   */
  catalogSnapshot(defaultModel: string): ProviderCatalog {
    const rows = this.store.runners.list().filter((row) => row.enabled === 1);
    const disabledProviders = this.disabledSet('disabledProviders');
    const disabledModels = this.disabledSet('disabledModels');
    const providers = new Map<string, { machines: Set<string>; models: Map<string, CatalogModel> }>();
    const entry = (name: string) => {
      let found = providers.get(name);
      if (!found) providers.set(name, (found = { machines: new Set(), models: new Map() }));
      return found;
    };
    for (const name of configuredProviderNames()) entry(name);
    for (const name of disabledProviders) entry(name);

    const machines: CatalogMachine[] = [];
    let fetchedAt: number | null = null;
    for (const row of rows) {
      const models = new Set<string>();
      for (const provider of row.catalog?.providers ?? []) {
        const merged = entry(provider.name);
        // Only a credential-ready provider contributes models: listing models
        // no machine can actually serve is what made the old page misleading.
        if (!provider.ready) continue;
        merged.machines.add(row.id);
        for (const model of provider.models) {
          models.add(model.id);
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
        modelCount: models.size,
      });
    }

    return {
      providers: [...providers.entries()]
        .map(([name, merged]): CatalogProvider => ({
          name,
          enabled: !disabledProviders.has(name),
          machines: [...merged.machines],
          models: [...merged.models.values()].sort((a, b) => a.id.localeCompare(b.id)),
        }))
        .sort((a, b) => b.models.length - a.models.length || a.name.localeCompare(b.name)),
      machines,
      disabledModels: [...disabledModels],
      defaultModel,
      fetchedAt,
    };
  }

  /** Providers that can serve `model`, merged across machines (null = unknown). */
  providersForModel(model: string | null): string[] | null {
    if (!model) return null;
    const names = this.modelProviders.get(model);
    return names && names.size > 0 ? [...names] : null;
  }

  private disabledSet(key: 'disabledProviders' | 'disabledModels'): Set<string> {
    try {
      const raw = this.store.settings.get(key);
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  }

  /**
   * Fetch a runner's own provider/model catalog by spawning a throwaway gateway
   * on that runner and reading moxxy's session info. Heavier than a health
   * probe — go through refreshCatalog, which dedupes and backs off.
   */
  private async probeCatalog(id: string): Promise<RunnerCatalog | null> {
    const backend = this.backends.get(id);
    if (!backend) return null;
    const probeId = `catalog-probe-${randomUUID().slice(0, 8)}`;
    try {
      const cwd = await backend.scratchDir(probeId);
      await backend.spawn(probeId, cwd);
      const catalog = parseCatalog((await backend.sessionInfo(probeId)) as SessionInfo);
      this.storeCatalog(id, catalog);
      return catalog;
    } catch (err) {
      log.warn('runner catalog probe failed', { runner: id, err: String(err) });
      return this.store.runners.get(id)?.catalog ?? null;
    } finally {
      await backend.stop(probeId).catch(() => undefined);
    }
  }

  private storeCatalog(id: string, catalog: RunnerCatalog): void {
    this.store.runners.setCatalog(id, catalog);
    this.rebuildModelIndex();
    this.broadcast({ t: 'runners.changed' });
  }

  /** Rebuild the model → providers map. Small data; rebuilt only on writes. */
  private rebuildModelIndex(): void {
    const index = new Map<string, Set<string>>();
    for (const row of this.store.runners.list()) {
      if (row.enabled !== 1) continue;
      for (const provider of row.catalog?.providers ?? []) {
        for (const model of provider.models) {
          for (const key of [model.id, `${provider.name}/${model.id}`]) {
            let names = index.get(key);
            if (!names) index.set(key, (names = new Set()));
            names.add(provider.name);
          }
        }
      }
    }
    this.modelProviders = index;
  }
}

type SessionInfo = { activeProvider?: unknown; providers?: unknown; readyProviders?: unknown } | null;

/** Parse moxxy session info into a per-runner catalog (providers + real readiness). */
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
