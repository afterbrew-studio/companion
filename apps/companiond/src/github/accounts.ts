import { randomUUID } from 'node:crypto';
import { GITHUB_PURPOSES, type GitHubAccountRecord, type GitHubPurpose } from '@companion/contract';
import { log } from '../log.js';
import { GitHubClient } from './client.js';
import type { Store } from '../store/db.js';

/**
 * Registry of connected GitHub accounts (PATs), each bound to one or more
 * purposes: 'fetch' (sync + checks), 'runs' (agent clones/pushes), 'pipelines'
 * (posting reviews/labels/comments), 'webhooks'. `clientFor(purpose)` picks
 * the first account bound to the purpose and falls back to any account, so a
 * single-account install behaves exactly like before.
 */
export class GitHubAccounts {
  private readonly clients = new Map<string, GitHubClient>();

  constructor(private readonly store: Store) {}

  /** One-time adoption of the legacy single PAT (settings table) into the registry. */
  migrateLegacyToken(): void {
    const token = this.store.settings.get('github_token');
    if (!token || this.store.githubAccounts.list().length > 0) return;
    const id = `gha-${randomUUID().slice(0, 12)}`;
    this.store.githubAccounts.insert({ id, login: '', token, purposes: GITHUB_PURPOSES, createdAt: Date.now() });
    // The token was validated when it was saved; fill the login lazily.
    new GitHubClient(token)
      .viewer()
      .then((v) => this.store.githubAccounts.update(id, { login: v.login }))
      .catch((err) => log.warn('legacy GitHub token failed validation during migration', { err: String(err) }));
    log.info('migrated legacy GitHub token into the accounts registry');
  }

  list(): GitHubAccountRecord[] {
    return this.store.githubAccounts
      .list()
      .map(({ id, login, purposes, createdAt }) => ({ id, login, purposes, createdAt }));
  }

  /** Validate the token, then insert (or replace the token of the same login). */
  async add(token: string, purposes: readonly GitHubPurpose[]): Promise<GitHubAccountRecord> {
    const client = new GitHubClient(token);
    const viewer = await client.viewer();
    const existing = this.store.githubAccounts.list().find((a) => a.login === viewer.login);
    if (existing) {
      this.store.githubAccounts.update(existing.id, { token, purposes });
      this.clients.set(existing.id, client);
      return { id: existing.id, login: viewer.login, purposes, createdAt: existing.createdAt };
    }
    const id = `gha-${randomUUID().slice(0, 12)}`;
    this.store.githubAccounts.insert({ id, login: viewer.login, token, purposes, createdAt: Date.now() });
    this.clients.set(id, client);
    return { id, login: viewer.login, purposes, createdAt: Date.now() };
  }

  setPurposes(id: string, purposes: readonly GitHubPurpose[]): GitHubAccountRecord {
    const row = this.store.githubAccounts.list().find((a) => a.id === id);
    if (!row) throw new Error(`unknown GitHub account: ${id}`);
    this.store.githubAccounts.update(id, { purposes });
    return { id, login: row.login, purposes, createdAt: row.createdAt };
  }

  remove(id: string): void {
    this.store.githubAccounts.delete(id);
    this.clients.delete(id);
  }

  /**
   * Resolution order: explicit account override (per action) → repo pin →
   * purpose binding → first connected account.
   */
  clientFor(purpose: GitHubPurpose, ctx?: { repo?: string; accountId?: string }): GitHubClient | null {
    const row = this.rowFor(purpose, ctx);
    if (!row) return null;
    let client = this.clients.get(row.id);
    if (!client) {
      client = new GitHubClient(row.token);
      this.clients.set(row.id, client);
    }
    return client;
  }

  tokenFor(purpose: GitHubPurpose, ctx?: { repo?: string; accountId?: string }): string | null {
    return this.rowFor(purpose, ctx)?.token ?? null;
  }

  loginFor(purpose: GitHubPurpose): string | null {
    const login = this.rowFor(purpose)?.login;
    return login ? login : null;
  }

  private rowFor(purpose: GitHubPurpose, ctx?: { repo?: string; accountId?: string }) {
    const rows = this.store.githubAccounts.list();
    if (ctx?.accountId) {
      const explicit = rows.find((r) => r.id === ctx.accountId);
      if (explicit) return explicit;
    }
    if (ctx?.repo) {
      const pin = this.store.repos.get(ctx.repo)?.github_account_id;
      if (pin) {
        const pinned = rows.find((r) => r.id === pin);
        if (pinned) return pinned;
      }
    }
    return rows.find((r) => r.purposes.includes(purpose)) ?? rows[0];
  }
}
