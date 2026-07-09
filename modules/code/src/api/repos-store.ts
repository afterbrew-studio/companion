import type Database from 'better-sqlite3';
import type { ServiceMap } from '@companion/contracts';
import type { RepoRecord } from '../contract/index.js';

/** Connected repos and their per-repo automation switches. */
export class ReposStore {
  constructor(
    private readonly db: Database.Database,
    private readonly workspaces: ServiceMap['workspace'],
  ) {}

  upsert(repo: {
    fullName: string;
    owner: string;
    name: string;
    defaultBranch: string;
    private: boolean;
    workspaceId?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO repos (full_name, owner, name, default_branch, private, workspace_id)
         VALUES (@fullName, @owner, @name, @defaultBranch, @isPrivate, @workspaceId)
         ON CONFLICT(full_name) DO UPDATE SET
           default_branch = excluded.default_branch, private = excluded.private,
           workspace_id = COALESCE(excluded.workspace_id, repos.workspace_id)`,
      )
      .run({ ...repo, isPrivate: repo.private ? 1 : 0, workspaceId: repo.workspaceId ?? null });
    // A row inserted without a workspace joins the default one.
    this.workspaces.ensureDefault();
  }

  setWorkspace(fullName: string, workspaceId: string): void {
    this.db.prepare(`UPDATE repos SET workspace_id = ? WHERE full_name = ?`).run(workspaceId, fullName);
  }

  listByWorkspace(workspaceId: string): RepoRow[] {
    return this.db
      .prepare(`SELECT * FROM repos WHERE workspace_id = ? ORDER BY full_name`)
      .all(workspaceId) as RepoRow[];
  }

  setCloneReady(fullName: string, ready: boolean): void {
    this.db.prepare(`UPDATE repos SET clone_ready = ? WHERE full_name = ?`).run(ready ? 1 : 0, fullName);
  }

  setSynced(fullName: string): void {
    this.db.prepare(`UPDATE repos SET last_sync_at = ? WHERE full_name = ?`).run(Date.now(), fullName);
  }

  setAutomation(
    fullName: string,
    field: 'auto_triage' | 'digest_enabled' | 'stale_enabled' | 'pr_gate' | 'auto_merge',
    value: boolean,
  ): void {
    this.db.prepare(`UPDATE repos SET ${field} = ? WHERE full_name = ?`).run(value ? 1 : 0, fullName);
  }

  setWebhookSecret(fullName: string, secret: string | null): void {
    this.db.prepare(`UPDATE repos SET webhook_secret = ? WHERE full_name = ?`).run(secret, fullName);
  }

  getWebhookSecret(fullName: string): string | null {
    const row = this.db.prepare(`SELECT webhook_secret FROM repos WHERE full_name = ?`).get(fullName) as
      | { webhook_secret: string | null }
      | undefined;
    return row?.webhook_secret ?? null;
  }

  setGithubAccount(fullName: string, accountId: string | null): void {
    this.db.prepare(`UPDATE repos SET github_account_id = ? WHERE full_name = ?`).run(accountId, fullName);
  }

  setRunner(fullName: string, runnerId: string | null): void {
    this.db.prepare(`UPDATE repos SET runner_id = ? WHERE full_name = ?`).run(runnerId, fullName);
  }

  get(fullName: string): RepoRow | undefined {
    return this.db.prepare(`SELECT * FROM repos WHERE full_name = ?`).get(fullName) as RepoRow | undefined;
  }

  list(): RepoRow[] {
    return this.db.prepare(`SELECT * FROM repos ORDER BY full_name`).all() as RepoRow[];
  }

  remove(fullName: string): void {
    this.db.prepare(`DELETE FROM issues WHERE repo = ?`).run(fullName);
    this.db.prepare(`DELETE FROM prs WHERE repo = ?`).run(fullName);
    this.db.prepare(`DELETE FROM repos WHERE full_name = ?`).run(fullName);
  }
}

export interface RepoRow {
  full_name: string;
  owner: string;
  name: string;
  workspace_id: string;
  github_account_id: string | null;
  runner_id: string | null;
  default_branch: string;
  private: number;
  clone_ready: number;
  last_sync_at: number | null;
  auto_triage: number;
  digest_enabled: number;
  stale_enabled: number;
  pr_gate: number;
  auto_merge: number;
  webhook_secret: string | null;
}

export function rowToRepo(row: RepoRow): RepoRecord {
  return {
    githubAccountId: row.github_account_id ?? null,
    runnerId: row.runner_id ?? null,
    fullName: row.full_name,
    owner: row.owner,
    name: row.name,
    workspaceId: row.workspace_id,
    defaultBranch: row.default_branch,
    private: row.private === 1,
    cloneReady: row.clone_ready === 1,
    lastSyncAt: row.last_sync_at,
    openIssues: 0, // filled by callers that have the count
    autoTriage: row.auto_triage === 1,
    digestEnabled: row.digest_enabled === 1,
    staleSweepEnabled: row.stale_enabled === 1,
    prGateEnabled: row.pr_gate === 1,
    autoMergeEnabled: row.auto_merge === 1,
    webhookConfigured: row.webhook_secret !== null,
  };
}
