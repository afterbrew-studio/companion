import type Database from 'better-sqlite3';
import type { GitHubAccountScope, GitHubPurpose } from '@companion/contract';

/**
 * Connected GitHub accounts (PATs) and what each one is used for. Workspace
 * delegation lives in a side table so an account can serve many workspaces
 * (and vice versa), mirroring runner delegation.
 */
export class GithubAccountsStore {
  constructor(private readonly db: Database.Database) {}

  insert(a: {
    id: string;
    login: string;
    token: string;
    purposes: readonly string[];
    scope: GitHubAccountScope;
    workspaceIds: readonly string[];
    createdAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO github_accounts (id, login, token, purposes, scope, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(a.id, a.login, a.token, JSON.stringify(a.purposes), a.scope, a.createdAt);
    this.setWorkspaces(a.id, a.workspaceIds);
  }

  /** Internal rows including tokens — never returned by the API layer. */
  list(): GithubAccountRow[] {
    const rows = this.db.prepare(`SELECT * FROM github_accounts ORDER BY created_at`).all() as Array<{
      id: string;
      login: string;
      token: string;
      purposes: string;
      scope: GitHubAccountScope;
      created_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      login: r.login,
      token: r.token,
      purposes: JSON.parse(r.purposes) as GitHubPurpose[],
      scope: r.scope,
      workspaceIds: r.scope === 'delegated' ? this.workspaceIds(r.id) : [],
      createdAt: r.created_at,
    }));
  }

  update(
    id: string,
    fields: {
      login?: string;
      token?: string;
      purposes?: readonly string[];
      scope?: GitHubAccountScope;
      workspaceIds?: readonly string[];
    },
  ): void {
    this.db
      .prepare(
        `UPDATE github_accounts SET
           login = COALESCE(?, login),
           token = COALESCE(?, token),
           purposes = COALESCE(?, purposes),
           scope = COALESCE(?, scope)
         WHERE id = ?`,
      )
      .run(
        fields.login ?? null,
        fields.token ?? null,
        fields.purposes ? JSON.stringify(fields.purposes) : null,
        fields.scope ?? null,
        id,
      );
    if (fields.workspaceIds !== undefined) this.setWorkspaces(id, fields.workspaceIds);
  }

  private workspaceIds(accountId: string): string[] {
    return (
      this.db
        .prepare(`SELECT workspace_id FROM github_account_workspaces WHERE account_id = ?`)
        .all(accountId) as Array<{ workspace_id: string }>
    ).map((r) => r.workspace_id);
  }

  private setWorkspaces(accountId: string, workspaceIds: readonly string[]): void {
    this.db.prepare(`DELETE FROM github_account_workspaces WHERE account_id = ?`).run(accountId);
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO github_account_workspaces (account_id, workspace_id) VALUES (?, ?)`,
    );
    for (const ws of workspaceIds) insert.run(accountId, ws);
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM github_account_workspaces WHERE account_id = ?`).run(id);
    this.db.prepare(`DELETE FROM github_accounts WHERE id = ?`).run(id);
  }

  /** Logins of the connected GitHub accounts — the identity behind "__me" filters. */
  logins(): string[] {
    return this.list().map((a) => a.login);
  }
}

export interface GithubAccountRow {
  id: string;
  login: string;
  token: string;
  purposes: GitHubPurpose[];
  scope: GitHubAccountScope;
  workspaceIds: string[];
  createdAt: number;
}
