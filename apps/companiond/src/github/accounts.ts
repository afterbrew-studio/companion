import { randomUUID } from 'node:crypto';
import {
  GITHUB_PURPOSES,
  type GitHubAccountRecord,
  type GitHubAccountScope,
  type GitHubPurpose,
} from '@companion/contract';
import { log } from '../log.js';
import { currentUser } from '../http/request-context.js';
import { GitHubClient } from './client.js';
import type { Store } from '../store/db.js';
import type { GithubAccountRow } from '../store/github-accounts.js';

/** Optional resolution context. `username` overrides the request-scoped invoker. */
type ResolveCtx = { repo?: string; accountId?: string; username?: string | null };

/**
 * Registry of connected GitHub accounts (PATs). Each is bound to purposes
 * ('fetch' | 'runs' | 'pipelines' | 'webhooks'), to where it may act (shared |
 * delegated), and to an owner. A user's OWN account is preferred when they
 * invoke an action; everything else falls back to the shared default accounts
 * (ownerId null) an admin manages. Resolution order: explicit accountId → the
 * invoking user's own eligible account → repo pin → shared default.
 */
export class GitHubAccounts {
  private readonly clients = new Map<string, GitHubClient>();

  constructor(private readonly store: Store) {}

  /** One-time adoption of the legacy single PAT into the registry as a shared default. */
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
      ownerId: null,
      createdAt: Date.now(),
    });
    new GitHubClient(token)
      .viewer()
      .then((v) => this.store.githubAccounts.update(id, { login: v.login }))
      .catch((err) => log.warn('legacy GitHub token failed validation during migration', { err: String(err) }));
    log.info('migrated legacy GitHub token into the accounts registry');
  }

  list(): GitHubAccountRecord[] {
    return this.store.githubAccounts.list().map(toRecord);
  }

  /** Validate the token, then insert (or replace the token of the same login). */
  async add(
    token: string,
    purposes: readonly GitHubPurpose[],
    scope: GitHubAccountScope = 'shared',
    workspaceIds: readonly string[] = [],
    ownerId: string | null = null,
  ): Promise<GitHubAccountRecord> {
    const client = new GitHubClient(token);
    const viewer = await client.viewer();
    const existing = this.store.githubAccounts.list().find((a) => a.login === viewer.login);
    if (existing) {
      this.store.githubAccounts.update(existing.id, { token, purposes, scope, workspaceIds });
      this.clients.set(existing.id, client);
      // Ownership stays with whoever first connected the account.
      return toRecord({ ...existing, login: viewer.login, purposes: [...purposes], scope, workspaceIds: [...workspaceIds] });
    }
    const id = `gha-${randomUUID().slice(0, 12)}`;
    const createdAt = Date.now();
    this.store.githubAccounts.insert({ id, login: viewer.login, token, purposes, scope, workspaceIds, ownerId, createdAt });
    this.clients.set(id, client);
    return { id, login: viewer.login, purposes: [...purposes], scope, workspaceIds: [...workspaceIds], ownerId, createdAt };
  }

  update(
    id: string,
    fields: { purposes?: readonly GitHubPurpose[]; scope?: GitHubAccountScope; workspaceIds?: readonly string[] },
  ): GitHubAccountRecord {
    const row = this.store.githubAccounts.list().find((a) => a.id === id);
    if (!row) throw new Error(`unknown GitHub account: ${id}`);
    this.store.githubAccounts.update(id, fields);
    const updated = this.store.githubAccounts.list().find((a) => a.id === id) ?? row;
    return toRecord(updated);
  }

  /** The stored row (owner check for management gates). */
  row(id: string): GithubAccountRow | undefined {
    return this.store.githubAccounts.list().find((a) => a.id === id);
  }

  remove(id: string): void {
    this.store.githubAccounts.delete(id);
    this.clients.delete(id);
  }

  clientFor(purpose: GitHubPurpose, ctx?: ResolveCtx): GitHubClient | null {
    const row = this.rowFor(purpose, ctx);
    if (!row) return null;
    let client = this.clients.get(row.id);
    if (!client) {
      client = new GitHubClient(row.token);
      this.clients.set(row.id, client);
    }
    return client;
  }

  tokenFor(purpose: GitHubPurpose, ctx?: ResolveCtx): string | null {
    return this.rowFor(purpose, ctx)?.token ?? null;
  }

  loginFor(purpose: GitHubPurpose): string | null {
    const login = this.rowFor(purpose)?.login;
    return login ? login : null;
  }

  private rowFor(purpose: GitHubPurpose, ctx?: ResolveCtx): GithubAccountRow | undefined {
    const rows = this.store.githubAccounts.list();
    if (ctx?.accountId) {
      const explicit = rows.find((r) => r.id === ctx.accountId);
      if (explicit) return explicit;
    }
    const repoRow = ctx?.repo ? this.store.repos.get(ctx.repo) : undefined;
    const workspaceId = repoRow?.workspace_id ?? null;
    const eligibleHere = (r: GithubAccountRow): boolean =>
      r.scope === 'shared' || (workspaceId !== null && r.workspaceIds.includes(workspaceId));

    // 1. The invoking user's own account, if it holds the purpose and is
    //    eligible here — a maintainer acts as themselves when they've connected.
    const username = ctx?.username ?? currentUser()?.username ?? null;
    if (username) {
      const mine = rows.find((r) => r.ownerId === username && r.purposes.includes(purpose) && eligibleHere(r));
      if (mine) return mine;
    }

    // 2. Repo pin (an admin forcing a specific account for this repo).
    if (repoRow?.github_account_id) {
      const pinned = rows.find((r) => r.id === repoRow.github_account_id);
      if (pinned) return pinned;
    }

    // 3. Shared default accounts (ownerId null) eligible for the workspace —
    //    delegated-to-it before shared. Falls back to all accounts when no
    //    shared default exists, so a single personal account still serves as
    //    the default (backward compatible).
    const defaults = rows.filter((r) => r.ownerId === null);
    const pool = defaults.length > 0 ? defaults : rows;
    let eligible: GithubAccountRow[];
    if (workspaceId) {
      eligible = [
        ...pool.filter((r) => r.scope === 'delegated' && r.workspaceIds.includes(workspaceId)),
        ...pool.filter((r) => r.scope === 'shared'),
      ];
    } else {
      const shared = pool.filter((r) => r.scope === 'shared');
      eligible = shared.length > 0 ? shared : pool;
    }
    return eligible.find((r) => r.purposes.includes(purpose)) ?? eligible[0];
  }
}

function toRecord(r: GithubAccountRow): GitHubAccountRecord {
  return {
    id: r.id,
    login: r.login,
    purposes: r.purposes,
    scope: r.scope,
    workspaceIds: r.workspaceIds,
    ownerId: r.ownerId,
    createdAt: r.createdAt,
  };
}
