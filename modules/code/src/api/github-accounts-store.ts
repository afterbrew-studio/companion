import type { Database } from '@moxxy/companion-sdk/server';
import type { GitHubAccountScope, GitHubCredentialKind, GitHubPurpose } from '../contract/index.js';

/**
 * Personal GitHub accounts and what each owner uses them for. SQLite keeps only
 * account metadata and an opaque marker; PATs, cached installation tokens and
 * App private keys live in the kernel SecretStore. Older plaintext rows migrate
 * synchronously before any account can be used.
 */
export class GithubAccountsStore {
  constructor(
    private readonly db: Database,
    private readonly secrets: CredentialSecrets,
  ) {
    this.migratePlaintextCredentials();
  }

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
    if (this.db.prepare(`SELECT 1 FROM github_accounts WHERE id = ?`).get(a.id)) {
      throw new Error(`GitHub account ${a.id} already exists`);
    }
    this.secrets.set(tokenKey(a.id), a.token);
    if (a.privateKey) this.secrets.set(privateKeyKey(a.id), a.privateKey);
    try {
      this.db.transaction(() => {
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
            SECRET_MARKER,
            JSON.stringify(a.purposes),
            a.scope,
            a.ownerId,
            a.createdAt,
            a.kind ?? 'pat',
            a.appId ?? null,
            a.installationId ?? null,
            a.privateKey ? SECRET_MARKER : null,
            a.tokenExpiresAt ?? null,
          );
        this.setWorkspaces(a.id, a.workspaceIds);
      })();
    } catch (error) {
      this.secrets.delete(tokenKey(a.id));
      this.secrets.delete(privateKeyKey(a.id));
      throw error;
    }
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
    this.requireAccount(id);
    this.secrets.set(privateKeyKey(id), app.privateKey);
    this.db
      .prepare(`UPDATE github_accounts SET kind = 'app', app_id = ?, installation_id = ?, private_key = ? WHERE id = ?`)
      .run(app.appId, app.installationId, SECRET_MARKER, id);
  }

  /**
   * Store a freshly minted installation token. Separate from `update` because
   * it is the refresh path, not a user edit: it must never touch purposes,
   * scope or workspaces, and it runs from a background job.
   */
  setInstallationToken(id: string, token: string, expiresAt: number): void {
    this.requireAccount(id);
    this.secrets.set(tokenKey(id), token);
    this.db
      .prepare(`UPDATE github_accounts SET token = ?, token_expires_at = ?, token_health = 'ok', token_error = NULL WHERE id = ?`)
      .run(SECRET_MARKER, expiresAt, id);
  }

  /**
   * Record that a refresh failed. Separate from the success path so a run that
   * throws leaves the previous token untouched: it is still valid for the rest
   * of the margin, and the next attempt may well succeed.
   */
  setTokenFailure(id: string, error: string): void {
    this.db
      .prepare(`UPDATE github_accounts SET token_health = 'failing', token_error = ? WHERE id = ?`)
      .run(error.slice(0, 300), id);
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
      token_health: string | null;
      token_error: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      login: r.login,
      token: this.requiredSecret(tokenKey(r.id), `GitHub credential ${r.id}`),
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
      privateKey: r.private_key === null
        ? null
        : this.requiredSecret(privateKeyKey(r.id), `GitHub App private key ${r.id}`),
      tokenExpiresAt: r.token_expires_at,
      // Null on a row no refresh has touched yet, which reads as "nothing known"
      // rather than as healthy: a PAT never refreshes at all.
      tokenHealth: r.token_health === 'ok' || r.token_health === 'failing' ? r.token_health : null,
      tokenError: r.token_error,
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
    this.requireAccount(id);
    if (fields.token !== undefined) this.secrets.set(tokenKey(id), fields.token);
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
        fields.token === undefined ? null : SECRET_MARKER,
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
    this.secrets.delete(tokenKey(id));
    this.secrets.delete(privateKeyKey(id));
  }

  private requiredSecret(key: string, label: string): string {
    const value = this.secrets.get(key);
    if (value === null || value === '') throw new Error(`${label} is unavailable from the secret store`);
    return value;
  }

  private requireAccount(id: string): void {
    if (!this.db.prepare(`SELECT 1 FROM github_accounts WHERE id = ?`).get(id)) {
      throw new Error(`GitHub account ${id} does not exist`);
    }
  }

  /** Move credentials written by releases before encrypted secret storage. */
  private migratePlaintextCredentials(): void {
    const rows = this.db
      .prepare(`SELECT id, token, private_key FROM github_accounts`)
      .all() as Array<{ id: string; token: string; private_key: string | null }>;
    const update = this.db.prepare(`UPDATE github_accounts SET token = ?, private_key = ? WHERE id = ?`);
    for (const row of rows) {
      if (row.token !== SECRET_MARKER) this.secrets.set(tokenKey(row.id), row.token);
      else this.requiredSecret(tokenKey(row.id), `GitHub credential ${row.id}`);
      if (row.private_key !== null && row.private_key !== SECRET_MARKER) {
        this.secrets.set(privateKeyKey(row.id), row.private_key);
      } else if (row.private_key === SECRET_MARKER) {
        this.requiredSecret(privateKeyKey(row.id), `GitHub App private key ${row.id}`);
      }
      update.run(SECRET_MARKER, row.private_key === null ? null : SECRET_MARKER, row.id);
    }
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

interface CredentialSecrets {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

const SECRET_MARKER = 'companion-secret:v1';
const tokenKey = (id: string): string => `github-account:${id}:token`;
const privateKeyKey = (id: string): string => `github-account:${id}:private-key`;

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
  /** Last refresh outcome; null when no refresh has ever run (every PAT). */
  tokenHealth: 'ok' | 'failing' | null;
  tokenError: string | null;
}
