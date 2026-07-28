import type Database from 'better-sqlite3';
import type {
  RunnerCatalog,
  RunnerKind,
  RunnerPolicyMode,
  RunnerProviderPolicy,
  RunnerRepoScope,
  RunnerScope,
  RunnerTaskPolicy,
} from '../contract/index.js';

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
  /** Superseded by the task policy below; kept so a rollback still reads it. */
  blocked_tasks: string[];
  /** How the two policy lists are read: allow-list or deny-list. */
  task_policy_mode: RunnerPolicyMode;
  /** Module ids the policy names — blanket entries (JSON array). */
  policy_modules: string[];
  /** Task ids the policy names individually (JSON array). */
  policy_tasks: string[];
  /** `selected` limits this machine to the repos in `repo_ids`. */
  repo_scope: RunnerRepoScope;
  /** Roles whose users may place here (JSON array); empty = every role. */
  allowed_roles: string[];
  /** Provider names agents may not use on this machine (JSON array). */
  disabled_providers: string[];
  /** Model ids agents may not use here, bare or `provider/id` (JSON array). */
  disabled_models: string[];
  /** Last-fetched provider/model catalog (JSON), or null. */
  catalog: RunnerCatalog | null;
  created_at: number;
  /** Filled by list()/get() joins — the delegated workspace ids. */
  workspace_ids: string[];
  /** Filled by list()/get() joins — the cleared repository full names. */
  repo_ids: string[];
}

/**
 * Execution machines. The local runner row is seeded once and pinned; remote
 * runners are added by an admin. Workspace delegation and repository clearance
 * live in side tables so a runner can serve many of each (and vice versa).
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
          `INSERT INTO runners (id, name, kind, endpoint, token, scope, max_runs, enabled, task_policy_mode, repo_scope, created_at)
           VALUES (?, 'This machine', 'local', NULL, NULL, 'shared', ?, 1, 'deny', 'all', ?)`,
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

  private repoIds(runnerId: string): string[] {
    return (
      this.db.prepare(`SELECT repo FROM runner_repos WHERE runner_id = ?`).all(runnerId) as Array<{ repo: string }>
    ).map((r) => r.repo);
  }

  private hydrate(row: RawRunnerRow): RunnerRow {
    const repoScope: RunnerRepoScope = row.repo_scope === 'selected' ? 'selected' : 'all';
    return {
      ...row,
      blocked_tasks: parseJson<string[]>(row.blocked_tasks, []),
      task_policy_mode: row.task_policy_mode === 'allow' ? 'allow' : 'deny',
      policy_modules: parseJson<string[]>(row.policy_modules, []),
      policy_tasks: parseJson<string[]>(row.policy_tasks, []),
      repo_scope: repoScope,
      allowed_roles: parseJson<string[]>(row.allowed_roles, []),
      disabled_providers: parseJson<string[]>(row.disabled_providers, []),
      disabled_models: parseJson<string[]>(row.disabled_models, []),
      catalog: parseJson<RunnerCatalog | null>(row.catalog, null),
      workspace_ids: row.scope === 'delegated' ? this.workspaceIds(row.id) : [],
      repo_ids: repoScope === 'selected' ? this.repoIds(row.id) : [],
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
    taskPolicy?: RunnerTaskPolicy;
  }): void {
    this.db
      .prepare(
        `INSERT INTO runners (id, name, kind, endpoint, token, scope, owner_id, max_runs, enabled,
                              task_policy_mode, policy_modules, policy_tasks, repo_scope, created_at)
         VALUES (@id, @name, @kind, @endpoint, @token, @scope, @ownerId, @maxRuns, 1,
                 @mode, @modules, @tasks, 'all', @createdAt)`,
      )
      .run({
        ...r,
        mode: r.taskPolicy?.mode ?? 'deny',
        modules: jsonList(r.taskPolicy?.modules),
        tasks: jsonList(r.taskPolicy?.tasks),
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
      /** Full replacement policy. Undefined = keep. */
      taskPolicy: RunnerTaskPolicy;
      repoScope: RunnerRepoScope;
      repoIds: readonly string[];
      /** Full replacement role list; empty opens it to every role. */
      allowedRoles: readonly string[];
    }>,
  ): void {
    const current = this.get(id);
    if (!current) return;
    const policy = fields.taskPolicy;
    const roles = fields.allowedRoles ?? current.allowed_roles;
    this.db
      .prepare(
        `UPDATE runners SET name = @name, endpoint = @endpoint, token = @token, scope = @scope,
         max_runs = @maxRuns, enabled = @enabled, task_policy_mode = @mode, policy_modules = @modules,
         policy_tasks = @tasks, repo_scope = @repoScope, allowed_roles = @roles WHERE id = @id`,
      )
      .run({
        id,
        name: fields.name ?? current.name,
        endpoint: fields.endpoint === undefined ? current.endpoint : fields.endpoint,
        token: fields.token ?? current.token,
        scope: fields.scope ?? current.scope,
        maxRuns: fields.maxRuns ?? current.max_runs,
        enabled: fields.enabled === undefined ? current.enabled : fields.enabled ? 1 : 0,
        mode: policy?.mode ?? current.task_policy_mode,
        modules: jsonList(policy ? policy.modules : current.policy_modules),
        tasks: jsonList(policy ? policy.tasks : current.policy_tasks),
        repoScope: fields.repoScope ?? current.repo_scope,
        roles: jsonList(roles),
      });
    if (fields.workspaceIds !== undefined) this.setWorkspaces(id, fields.workspaceIds);
    if (fields.repoIds !== undefined) this.setRepos(id, fields.repoIds);
  }

  /** Replace which providers/models agents may use on this machine. */
  setProviderPolicy(id: string, policy: RunnerProviderPolicy): void {
    this.db
      .prepare(`UPDATE runners SET disabled_providers = ?, disabled_models = ? WHERE id = ?`)
      .run(
        policy.disabledProviders.length ? JSON.stringify(policy.disabledProviders) : null,
        policy.disabledModels.length ? JSON.stringify(policy.disabledModels) : null,
        id,
      );
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

  private setRepos(runnerId: string, repos: readonly string[]): void {
    this.db.prepare(`DELETE FROM runner_repos WHERE runner_id = ?`).run(runnerId);
    const insert = this.db.prepare(`INSERT OR IGNORE INTO runner_repos (runner_id, repo) VALUES (?, ?)`);
    for (const repo of repos) insert.run(runnerId, repo);
  }

  delete(id: string): void {
    if (id === LOCAL_RUNNER_ID) throw new Error('the local runner cannot be deleted');
    this.db.prepare(`DELETE FROM runner_workspaces WHERE runner_id = ?`).run(id);
    this.db.prepare(`DELETE FROM runner_repos WHERE runner_id = ?`).run(id);
    this.db.prepare(`DELETE FROM runners WHERE id = ?`).run(id);
  }

  /** Token for a remote runner (never leaves the daemon). */
  tokenFor(id: string): string | null {
    return this.get(id)?.token ?? null;
  }
}

/** Row as SQLite returns it — JSON columns are still strings here. */
type RawRunnerRow = Omit<
  RunnerRow,
  | 'workspace_ids'
  | 'repo_ids'
  | 'blocked_tasks'
  | 'task_policy_mode'
  | 'policy_modules'
  | 'policy_tasks'
  | 'repo_scope'
  | 'allowed_roles'
  | 'disabled_providers'
  | 'disabled_models'
  | 'catalog'
> & {
  blocked_tasks: string | null;
  task_policy_mode: string | null;
  policy_modules: string | null;
  policy_tasks: string | null;
  repo_scope: string | null;
  allowed_roles: string | null;
  disabled_providers: string | null;
  disabled_models: string | null;
  catalog: string | null;
};

/** Empty lists store as NULL, so "never set" and "set to nothing" stay one value. */
function jsonList(values: readonly string[] | undefined): string | null {
  return values && values.length > 0 ? JSON.stringify(values) : null;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
