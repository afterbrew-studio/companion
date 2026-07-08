import { randomUUID } from 'node:crypto';
import {
  GITHUB_PURPOSES,
  type GitHubAccountRecord,
  type GitHubAccountScope,
  type GitHubPurpose,
} from '@companion/contract';
import { log } from '../log.js';
import { GitHubClient } from './client.js';
import type { Store } from '../store/db.js';
import type { GithubAccountRow } from '../store/github-accounts.js';

/**
 * Registry of connected GitHub accounts (PATs), each bound to one or more
 * purposes: 'fetch' (sync + checks), 'runs' (agent clones/pushes), 'pipelines'
 * (posting reviews/labels/comments), 'webhooks' — and to where it may act:
 * `shared` accounts serve any workspace, `delegated` accounts only the
 * workspaces assigned to them. `clientFor(purpose, ctx)` resolves among the
 * accounts eligible for the repo's workspace, preferring ones delegated to it,
 * so a single shared account behaves exactly like before.
 */
export class GitHubAccounts {
  private readonly clients = new Map<string, GitHubClient>();

  constructor(private readonly store: Store) {}

  /** One-time adoption of the legacy single PAT (settings table) into the registry. */
  migrateLegacyToken(): void {
    const token = this.store.settings.get('github_token');
    if (!token || this.store.githubAccounts.list().length > 0) return;
    const id = `gha-${randomUUID().slice(0, 12)}`;
    this.store.githubAccounts.insert({
      id,
      login: '',
      token,
      purposes: GITHUB_PURPOSES,
      scope: 'shared',
      workspaceIds: [],
      createdAt: Date.now(),
    });
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
      .map(({ id, login, purposes, scope, workspaceIds, createdAt }) => ({
        id,
        login,
        purposes,
        scope,
        workspaceIds,
        createdAt,
      }));
  }

  /** Validate the token, then insert (or replace the token of the same login). */
  async add(
    token: string,
    purposes: readonly GitHubPurpose[],
    scope: GitHubAccountScope = 'shared',
    workspaceIds: readonly string[] = [],
  ): Promise<GitHubAccountRecord> {
    const client = new GitHubClient(token);
    const viewer = await client.viewer();
    const existing = this.store.githubAccounts.list().find((a) => a.login === viewer.login);
    if (existing) {
      this.store.githubAccounts.update(existing.id, { token, purposes, scope, workspaceIds });
      this.clients.set(existing.id, client);
      return { id: existing.id, login: viewer.login, purposes, scope, workspaceIds, createdAt: existing.createdAt };
    }
    const id = `gha-${randomUUID().slice(0, 12)}`;
    const createdAt = Date.now();
    this.store.githubAccounts.insert({ id, login: viewer.login, token, purposes, scope, workspaceIds, createdAt });
    this.clients.set(id, client);
    return { id, login: viewer.login, purposes, scope, workspaceIds, createdAt };
  }

  update(
    id: string,
    fields: { purposes?: readonly GitHubPurpose[]; scope?: GitHubAccountScope; workspaceIds?: readonly string[] },
  ): GitHubAccountRecord {
    const row = this.store.githubAccounts.list().find((a) => a.id === id);
    if (!row) throw new Error(`unknown GitHub account: ${id}`);
    this.store.githubAccounts.update(id, fields);
    const updated = this.store.githubAccounts.list().find((a) => a.id === id) ?? row;
    const { login, purposes, scope, workspaceIds, createdAt } = updated;
    return { id, login, purposes, scope, workspaceIds, createdAt };
  }

  remove(id: string): void {
    this.store.githubAccounts.delete(id);
    this.clients.delete(id);
  }

  /**
   * Resolution order: explicit account override (per action) → repo pin →
   * purpose binding among the accounts eligible for the repo's workspace
   * (delegated-to-it first, then shared) → first eligible account.
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

  private rowFor(purpose: GitHubPurpose, ctx?: { repo?: string; accountId?: string }): GithubAccountRow | undefined {
    const rows = this.store.githubAccounts.list();
    if (ctx?.accountId) {
      const explicit = rows.find((r) => r.id === ctx.accountId);
      if (explicit) return explicit;
    }
    const repoRow = ctx?.repo ? this.store.repos.get(ctx.repo) : undefined;
    if (repoRow?.github_account_id) {
      const pinned = rows.find((r) => r.id === repoRow.github_account_id);
      if (pinned) return pinned;
    }
    // Eligibility by workspace, delegated-to-it before shared so a delegated
    // account wins its own workspace. A repo whose workspace has no eligible
    // account gets none — delegation is isolation, same as runners. Calls with
    // no repo context are instance-level: shared accounts serve them, falling
    // back to all accounts so an all-delegated install keeps status/sync alive.
    const workspaceId = repoRow?.workspace_id ?? null;
    let eligible: GithubAccountRow[];
    if (workspaceId) {
      eligible = [
        ...rows.filter((r) => r.scope === 'delegated' && r.workspaceIds.includes(workspaceId)),
        ...rows.filter((r) => r.scope === 'shared'),
      ];
    } else {
      const shared = rows.filter((r) => r.scope === 'shared');
      eligible = shared.length > 0 ? shared : rows;
    }
    return eligible.find((r) => r.purposes.includes(purpose)) ?? eligible[0];
  }
}
