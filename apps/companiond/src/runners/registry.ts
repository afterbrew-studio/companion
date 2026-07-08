import { randomUUID } from 'node:crypto';
import type {
  CreateRunnerRequest,
  RunnerHealth,
  RunnerProbeResult,
  RunnerRecord,
  SpaServerMessage,
  UpdateRunnerRequest,
} from '@companion/contract';
import { log } from '../log.js';
import type { Store } from '../store/db.js';
import { LOCAL_RUNNER_ID, type RunnerRow } from '../store/runners.js';
import type { Checkouts } from '../git/checkouts.js';
import type { MoxxyCli } from '../moxxy/cli.js';
import type { RunnerBackend, RunnerEventSink } from './backend.js';
import { LocalRunnerBackend } from './local-backend.js';
import { RemoteRunnerBackend } from './remote-backend.js';

const HEALTH_POLL_MS = 30_000;
const UNKNOWN_HEALTH: RunnerHealth = {
  status: 'unknown',
  moxxyVersion: null,
  moxxyCompatible: false,
  liveRuns: 0,
  maxRuns: 0,
  lastSeenAt: null,
  detail: null,
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

  constructor(
    private readonly store: Store,
    checkouts: Checkouts,
    moxxyCli: MoxxyCli | null,
    maxLiveRuns: number,
    private readonly sink: RunnerEventSink,
    private readonly broadcast: (msg: SpaServerMessage) => void,
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
  }

  /** The always-present local backend (used for shutdown-all). */
  get localBackend(): LocalRunnerBackend {
    return this.local;
  }

  start(): void {
    void this.pollHealth();
    this.healthTimer = setInterval(() => void this.pollHealth(), HEALTH_POLL_MS);
    this.healthTimer.unref();
  }

  stop(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
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
      this.backends.set(row.id, new RemoteRunnerBackend(row.id, row.endpoint, row.token, this.sink));
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
   */
  place(repo: string | null): string | null {
    const workspaceId = repo ? (this.store.repos.get(repo)?.workspace_id ?? null) : null;
    const eligible = this.store.runners.eligibleFor(workspaceId);
    const pinned = repo ? (this.store.repos.get(repo)?.runner_id ?? null) : null;

    const online = (row: RunnerRow): boolean => {
      const h = this.health.get(row.id);
      // Unprobed runners are optimistically allowed (first placement before
      // the first poll); offline ones are skipped.
      return !h || h.status === 'online' || h.status === 'degraded' || h.status === 'unknown';
    };
    const load = (row: RunnerRow): number => this.backend(row.id).liveIds().length / Math.max(1, row.max_runs);

    if (pinned) {
      const pin = eligible.find((r) => r.id === pinned);
      if (pin && online(pin)) return this.normalize(pin.id);
    }
    const candidates = eligible.filter(online).sort((a, b) => load(a) - load(b));
    const chosen = candidates[0];
    return this.normalize(chosen?.id ?? LOCAL_RUNNER_ID);
  }

  /** Store null for the local runner so existing rows/queries stay simple. */
  private normalize(id: string): string | null {
    return id === LOCAL_RUNNER_ID ? null : id;
  }

  // ---------- health ----------

  private async pollHealth(): Promise<void> {
    let changed = false;
    for (const [id, backend] of this.backends) {
      try {
        const h = await backend.probe();
        if (JSON.stringify(this.health.get(id)) !== JSON.stringify(h)) changed = true;
        this.health.set(id, h);
      } catch (err) {
        log.warn('runner health probe failed', { runner: id, err: String(err) });
      }
    }
    if (changed) this.broadcast({ t: 'runners.changed' });
  }

  healthFor(id: string): RunnerHealth {
    return this.health.get(id) ?? UNKNOWN_HEALTH;
  }

  // ---------- CRUD (drives store + backend rebuild) ----------

  list(): RunnerRecord[] {
    return this.store.runners.list().map((r) => this.toRecord(r));
  }

  get(id: string): RunnerRecord | undefined {
    const row = this.store.runners.get(id);
    return row ? this.toRecord(row) : undefined;
  }

  async create(req: CreateRunnerRequest): Promise<RunnerRecord> {
    const id = `runner-${randomUUID().slice(0, 12)}`;
    this.store.runners.insert({
      id,
      name: req.name,
      kind: 'remote',
      endpoint: req.endpoint.replace(/\/+$/, ''),
      token: req.token,
      scope: req.scope ?? 'shared',
      maxRuns: req.maxRuns ?? 3,
      workspaceIds: req.workspaceIds ?? [],
    });
    this.rebuildRemotes();
    await this.probeOne(id);
    this.broadcast({ t: 'runners.changed' });
    return this.get(id)!;
  }

  async update(id: string, req: UpdateRunnerRequest): Promise<RunnerRecord> {
    const row = this.store.runners.get(id);
    if (!row) throw new Error('runner not found');
    if (row.kind === 'local') {
      // Only capacity + scope are meaningful for the local runner.
      this.store.runners.update(id, {
        name: req.name,
        maxRuns: req.maxRuns,
        scope: req.scope,
        workspaceIds: req.workspaceIds,
        enabled: req.enabled,
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
      });
      this.rebuildRemotes();
      await this.probeOne(id);
    }
    this.broadcast({ t: 'runners.changed' });
    return this.get(id)!;
  }

  delete(id: string): void {
    this.store.runners.delete(id);
    const backend = this.backends.get(id);
    if (backend instanceof RemoteRunnerBackend) backend.dispose();
    this.backends.delete(id);
    this.health.delete(id);
    // Repos pinned to this runner fall back to auto-placement.
    for (const repo of this.store.repos.list()) {
      if (repo.runner_id === id) this.store.repos.setRunner(repo.full_name, null);
    }
    this.broadcast({ t: 'runners.changed' });
  }

  /** The "Test connection" action — probe now and return the health. */
  async probeNow(id: string): Promise<RunnerProbeResult> {
    const health = await this.probeOne(id);
    this.broadcast({ t: 'runners.changed' });
    return { ok: health.status === 'online' || health.status === 'degraded', health };
  }

  private async probeOne(id: string): Promise<RunnerHealth> {
    const backend = this.backends.get(id);
    if (!backend) return UNKNOWN_HEALTH;
    const health = await backend.probe();
    this.health.set(id, health);
    return health;
  }

  private toRecord(row: RunnerRow): RunnerRecord {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      endpoint: row.endpoint,
      hasToken: Boolean(row.token),
      scope: row.scope,
      workspaceIds: row.workspace_ids,
      maxRuns: row.max_runs,
      enabled: row.enabled === 1,
      health: this.healthFor(row.id),
      createdAt: row.created_at,
    };
  }
}
