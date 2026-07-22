import type Database from 'better-sqlite3';
import type { RunnerCatalog, RunnerKind, RunnerModelPins, RunnerScope } from '../contract/index.js';

/** The built-in runner: companiond's own machine. Always present, undeletable. */
export const LOCAL_RUNNER_ID = 'runner-local';

/** Row shape as stored (token stays here; the API layer strips it). */
export interface RunnerRow {
  id: string;
  name: string;
  kind: RunnerKind;
  endpoint: string | null;
  token: string | null;
  scope: RunnerScope;
  /** Owning user; null = shared instance runner. */
  owner_id: string | null;
  max_runs: number;
  enabled: number;
  /** Per-action model pins (JSON: kind → model id). */
  model_pins: RunnerModelPins;
  /** Task ids this runner refuses (JSON array); empty = takes everything. */
  blocked_tasks: string[];
  /** Last-fetched provider/model catalog (JSON), or null. */
  catalog: RunnerCatalog | null;
  created_at: number;
  /** Filled by list()/get() joins — the delegated workspace ids. */
  workspace_ids: string[];
}

/**
 * Execution machines. The local runner row is seeded once and pinned; remote
 * runners are added by an admin. Workspace delegation lives in a side table so
 * a runner can serve many workspaces (and vice versa).
 */
export class RunnersStore {
  constructor(private readonly db: Database.Database) {
    this.ensureLocal();
  }

  private ensureLocal(): void {
    const exists = this.db.prepare(`SELECT 1 FROM runners WHERE id = ?`).get(LOCAL_RUNNER_ID);
    if (!exists) {
      this.db
        .prepare(
          `INSERT INTO runners (id, name, kind, endpoint, token, scope, max_runs, enabled, created_at)
           VALUES (?, 'This machine', 'local', NULL, NULL, 'shared', ?, 1, ?)`,
        )
        .run(LOCAL_RUNNER_ID, 3, Date.now());
    }
  }

  private workspaceIds(runnerId: string): string[] {
    return (
      this.db.prepare(`SELECT workspace_id FROM runner_workspaces WHERE runner_id = ?`).all(runnerId) as Array<{
        workspace_id: string;
      }>
    ).map((r) => r.workspace_id);
  }

  private hydrate(row: RawRunnerRow): RunnerRow {
    return {
      ...row,
      model_pins: parseJson<RunnerModelPins>(row.model_pins, {}),
      blocked_tasks: parseJson<string[]>(row.blocked_tasks, []),
      catalog: parseJson<RunnerCatalog | null>(row.catalog, null),
      workspace_ids: row.scope === 'delegated' ? this.workspaceIds(row.id) : [],
    };
  }

  list(): RunnerRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM runners ORDER BY kind = 'local' DESC, created_at`)
      .all() as RawRunnerRow[];
    return rows.map((r) => this.hydrate(r));
  }

  get(id: string): RunnerRow | undefined {
    const row = this.db.prepare(`SELECT * FROM runners WHERE id = ?`).get(id) as RawRunnerRow | undefined;
    return row ? this.hydrate(row) : undefined;
  }

  /**
   * Enabled runners eligible for a workspace: shared ones + those delegated to
   * it. A personally-owned runner is only eligible for runs its owner triggers
   * — `userId` null (automation) excludes every owned runner.
   */
  eligibleFor(workspaceId: string | null, userId: string | null = null): RunnerRow[] {
    return this.list().filter(
      (r) =>
        r.enabled === 1 &&
        (r.owner_id === null || r.owner_id === userId) &&
        (r.scope === 'shared' || (workspaceId !== null && r.workspace_ids.includes(workspaceId))),
    );
  }

  insert(r: {
    id: string;
    name: string;
    kind: RunnerKind;
    endpoint: string | null;
    token: string | null;
    scope: RunnerScope;
    ownerId: string | null;
    maxRuns: number;
    workspaceIds: readonly string[];
    modelPins?: RunnerModelPins;
    blockedTasks?: readonly string[];
  }): void {
    this.db
      .prepare(
        `INSERT INTO runners (id, name, kind, endpoint, token, scope, owner_id, max_runs, enabled, model_pins, blocked_tasks, created_at)
         VALUES (@id, @name, @kind, @endpoint, @token, @scope, @ownerId, @maxRuns, 1, @modelPins, @blockedTasks, @createdAt)`,
      )
      .run({
        ...r,
        modelPins: JSON.stringify(r.modelPins ?? {}),
        blockedTasks: r.blockedTasks?.length ? JSON.stringify(r.blockedTasks) : null,
        createdAt: Date.now(),
      });
    this.setWorkspaces(r.id, r.workspaceIds);
  }

  update(
    id: string,
    fields: Partial<{
      name: string;
      endpoint: string | null;
      token: string;
      scope: RunnerScope;
      maxRuns: number;
      enabled: boolean;
      workspaceIds: readonly string[];
      modelPins: RunnerModelPins;
      /** Full replacement block-list; empty clears it. Undefined = keep. */
      blockedTasks: readonly string[];
    }>,
  ): void {
    const current = this.get(id);
    if (!current) return;
    const blockedTasks = fields.blockedTasks ?? current.blocked_tasks;
    this.db
      .prepare(
        `UPDATE runners SET name = @name, endpoint = @endpoint, token = @token, scope = @scope,
         max_runs = @maxRuns, enabled = @enabled, model_pins = @modelPins, blocked_tasks = @blockedTasks WHERE id = @id`,
      )
      .run({
        id,
        name: fields.name ?? current.name,
        endpoint: fields.endpoint === undefined ? current.endpoint : fields.endpoint,
        token: fields.token ?? current.token,
        scope: fields.scope ?? current.scope,
        maxRuns: fields.maxRuns ?? current.max_runs,
        enabled: fields.enabled === undefined ? current.enabled : fields.enabled ? 1 : 0,
        modelPins: JSON.stringify(fields.modelPins ?? current.model_pins),
        blockedTasks: blockedTasks.length ? JSON.stringify(blockedTasks) : null,
      });
    if (fields.workspaceIds !== undefined) this.setWorkspaces(id, fields.workspaceIds);
  }

  /** Cache a runner's freshly-probed provider/model catalog. */
  setCatalog(id: string, catalog: RunnerCatalog | null): void {
    this.db
      .prepare(`UPDATE runners SET catalog = ? WHERE id = ?`)
      .run(catalog ? JSON.stringify(catalog) : null, id);
  }

  private setWorkspaces(runnerId: string, workspaceIds: readonly string[]): void {
    this.db.prepare(`DELETE FROM runner_workspaces WHERE runner_id = ?`).run(runnerId);
    const insert = this.db.prepare(`INSERT OR IGNORE INTO runner_workspaces (runner_id, workspace_id) VALUES (?, ?)`);
    for (const ws of workspaceIds) insert.run(runnerId, ws);
  }

  delete(id: string): void {
    if (id === LOCAL_RUNNER_ID) throw new Error('the local runner cannot be deleted');
    this.db.prepare(`DELETE FROM runner_workspaces WHERE runner_id = ?`).run(id);
    this.db.prepare(`DELETE FROM runners WHERE id = ?`).run(id);
  }

  /** Token for a remote runner (never leaves the daemon). */
  tokenFor(id: string): string | null {
    return this.get(id)?.token ?? null;
  }
}

/** Row as SQLite returns it — JSON columns are still strings here. */
type RawRunnerRow = Omit<RunnerRow, 'workspace_ids' | 'model_pins' | 'blocked_tasks' | 'catalog'> & {
  model_pins: string;
  blocked_tasks: string | null;
  catalog: string | null;
};

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
