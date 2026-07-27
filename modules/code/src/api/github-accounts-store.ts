import type Database from 'better-sqlite3';
import type { GitHubAccountScope, GitHubCredentialKind, GitHubPurpose } from '../contract/index.js';

/**
 * Personal GitHub accounts and what each owner uses them for. A row is either a
 * personal access token or a GitHub App installation; `token` is the credential
 * itself for a PAT and the cached, expiring installation token for an app.
 * Workspace selection lives in a side table; it never grants another profile
 * access.
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
    ownerId: string | null;
    createdAt: number;
    kind?: GitHubCredentialKind;
    appId?: string | null;
    installationId?: string | null;
    privateKey?: string | null;
    tokenExpiresAt?: number | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO github_accounts
           (id, login, token, purposes, scope, owner_id, created_at,
            kind, app_id, installation_id, private_key, token_expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        a.id,
        a.login,
        a.token,
        JSON.stringify(a.purposes),
        a.scope,
        a.ownerId,
        a.createdAt,
        a.kind ?? 'pat',
        a.appId ?? null,
        a.installationId ?? null,
        a.privateKey ?? null,
        a.tokenExpiresAt ?? null,
      );
    this.setWorkspaces(a.id, a.workspaceIds);
  }

  /**
   * Replace the app credentials of an existing row.
   *
   * Reconnecting means "use these credentials now": rotating the private key or
   * pointing at a different installation must actually take effect. Leaving the
   * old ones in place would report success while the daemon kept authenticating
   * with the credential the operator just replaced.
   */
  setAppCredentials(id: string, app: { appId: string; installationId: string; privateKey: string }): void {
    this.db
      .prepare(`UPDATE github_accounts SET kind = 'app', app_id = ?, installation_id = ?, private_key = ? WHERE id = ?`)
      .run(app.appId, app.installationId, app.privateKey, id);
  }

  /**
   * Store a freshly minted installation token. Separate from `update` because
   * it is the refresh path, not a user edit: it must never touch purposes,
   * scope or workspaces, and it runs from a background job.
   */
  setInstallationToken(id: string, token: string, expiresAt: number): void {
    this.db
      .prepare(`UPDATE github_accounts SET token = ?, token_expires_at = ? WHERE id = ?`)
      .run(token, expiresAt, id);
  }

  /** Internal rows including tokens — never returned by the API layer. */
  list(): GithubAccountRow[] {
    const rows = this.db.prepare(`SELECT * FROM github_accounts ORDER BY created_at`).all() as Array<{
      id: string;
      login: string;
      token: string;
      purposes: string;
      scope: GitHubAccountScope | 'shared' | 'delegated';
      owner_id: string | null;
      created_at: number;
      kind: GitHubCredentialKind | null;
      app_id: string | null;
      installation_id: string | null;
      private_key: string | null;
      token_expires_at: number | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      login: r.login,
      token: r.token,
      purposes: JSON.parse(r.purposes) as GitHubPurpose[],
      // Normalize pre-personal-account values without a destructive migration.
      scope: r.scope === 'delegated' || r.scope === 'selected' ? 'selected' : 'all',
      workspaceIds: r.scope === 'delegated' || r.scope === 'selected' ? this.workspaceIds(r.id) : [],
      ownerId: r.owner_id,
      createdAt: r.created_at,
      // Rows written before the app migration have no `kind`; they are PATs.
      kind: r.kind === 'app' ? 'app' : 'pat',
      appId: r.app_id,
      installationId: r.installation_id,
      privateKey: r.private_key,
      tokenExpiresAt: r.token_expires_at,
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
    this.db.prepare(`DELETE FROM repo_account_bindings WHERE account_id = ?`).run(id);
    this.db.prepare(`DELETE FROM github_accounts WHERE id = ?`).run(id);
  }

  // ---------- per-repo bindings ----------

  /** The account this owner chose to act with on this repo, if any. */
  binding(repo: string, ownerId: string): string | null {
    const row = this.db
      .prepare(`SELECT account_id FROM repo_account_bindings WHERE repo = ? AND owner_id = ?`)
      .get(repo, ownerId) as { account_id: string } | undefined;
    return row?.account_id ?? null;
  }

  /** Every binding this owner has, keyed by repo — one query for a repo list. */
  bindingsFor(ownerId: string): Map<string, string> {
    const rows = this.db
      .prepare(`SELECT repo, account_id FROM repo_account_bindings WHERE owner_id = ?`)
      .all(ownerId) as Array<{ repo: string; account_id: string }>;
    return new Map(rows.map((r) => [r.repo, r.account_id]));
  }

  setBinding(repo: string, ownerId: string, accountId: string | null): void {
    if (accountId === null) {
      this.db.prepare(`DELETE FROM repo_account_bindings WHERE repo = ? AND owner_id = ?`).run(repo, ownerId);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO repo_account_bindings (repo, owner_id, account_id, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(repo, owner_id) DO UPDATE SET account_id = excluded.account_id`,
      )
      .run(repo, ownerId, accountId, Date.now());
  }

  /** Legacy broad helper; request routes pass the current profile's logins explicitly. */
  logins(): string[] {
    return this.list().map((a) => a.login);
  }
}

export interface GithubAccountRow {
  id: string;
  login: string;
  /** A PAT, or the cached installation token of a GitHub App. */
  token: string;
  purposes: GitHubPurpose[];
  scope: GitHubAccountScope;
  workspaceIds: string[];
  ownerId: string | null;
  createdAt: number;
  kind: GitHubCredentialKind;
  appId: string | null;
  installationId: string | null;
  /** The app's PEM. Never leaves the server, exactly like `token`. */
  privateKey: string | null;
  /** Epoch ms; null for a PAT, which does not expire on a schedule we know. */
  tokenExpiresAt: number | null;
}
