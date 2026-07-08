import type Database from 'better-sqlite3';
import type { RunnerKind, RunnerScope } from '@companion/contract';

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
  max_runs: number;
  enabled: number;
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

  private hydrate(row: Omit<RunnerRow, 'workspace_ids'>): RunnerRow {
    return { ...row, workspace_ids: row.scope === 'delegated' ? this.workspaceIds(row.id) : [] };
  }

  list(): RunnerRow[] {
    const rows = this.db.prepare(`SELECT * FROM runners ORDER BY kind = 'local' DESC, created_at`).all() as Array<
      Omit<RunnerRow, 'workspace_ids'>
    >;
    return rows.map((r) => this.hydrate(r));
  }

  get(id: string): RunnerRow | undefined {
    const row = this.db.prepare(`SELECT * FROM runners WHERE id = ?`).get(id) as
      | Omit<RunnerRow, 'workspace_ids'>
      | undefined;
    return row ? this.hydrate(row) : undefined;
  }

  /** Enabled runners eligible for a workspace: shared ones + those delegated to it. */
  eligibleFor(workspaceId: string | null): RunnerRow[] {
    return this.list().filter(
      (r) => r.enabled === 1 && (r.scope === 'shared' || (workspaceId !== null && r.workspace_ids.includes(workspaceId))),
    );
  }

  insert(r: {
    id: string;
    name: string;
    kind: RunnerKind;
    endpoint: string | null;
    token: string | null;
    scope: RunnerScope;
    maxRuns: number;
    workspaceIds: readonly string[];
  }): void {
    this.db
      .prepare(
        `INSERT INTO runners (id, name, kind, endpoint, token, scope, max_runs, enabled, created_at)
         VALUES (@id, @name, @kind, @endpoint, @token, @scope, @maxRuns, 1, @createdAt)`,
      )
      .run({ ...r, createdAt: Date.now() });
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
    }>,
  ): void {
    const current = this.get(id);
    if (!current) return;
    this.db
      .prepare(
        `UPDATE runners SET name = @name, endpoint = @endpoint, token = @token, scope = @scope,
         max_runs = @maxRuns, enabled = @enabled WHERE id = @id`,
      )
      .run({
        id,
        name: fields.name ?? current.name,
        endpoint: fields.endpoint === undefined ? current.endpoint : fields.endpoint,
        token: fields.token ?? current.token,
        scope: fields.scope ?? current.scope,
        maxRuns: fields.maxRuns ?? current.max_runs,
        enabled: fields.enabled === undefined ? current.enabled : fields.enabled ? 1 : 0,
      });
    if (fields.workspaceIds !== undefined) this.setWorkspaces(id, fields.workspaceIds);
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
