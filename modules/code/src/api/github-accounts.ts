import { randomUUID } from 'node:crypto';
import {
  type GitHubAccountRecord,
  type GitHubAccountScope,
  type GitHubPurpose,
  type RepoCandidate,
} from '../contract/index.js';
import { log, currentUser } from '@companion/services';
import { GitHubClient, GitHubError } from './github-client.js';
import type { CodeStore } from './code-store.js';
import type { GithubAccountRow } from './github-accounts-store.js';

/**
 * Optional resolution context. `username` overrides the request-scoped invoker;
 * `workspaceId` explicitly selects the target workspace. This matters while
 * adding a repo that is already connected elsewhere: account eligibility must
 * be checked against the requested destination, not the existing connection.
 */
type ResolveCtx = {
  repo?: string;
  accountId?: string;
  username?: string | null;
  workspaceId?: string;
};

/** How long a repo-access probe result (per account) stays trusted. */
const ACCESS_TTL_MS = 5 * 60_000;

/**
 * Registry of personal GitHub accounts (PATs). Every credential belongs to a
 * Companion profile and can only be resolved for that same profile. Multiple
 * accounts per user are supported; workspace selection only decides which of
 * their own accounts is eligible, never who may borrow it.
 */
export class GitHubAccounts {
  private readonly clients = new Map<string, GitHubClient>();
  /** `${accountId}:${repo}` → probed repo visibility (TTL'd, cleared on account changes). */
  private readonly repoAccess = new Map<string, { readonly ok: boolean; readonly at: number }>();

  constructor(private readonly store: CodeStore) {}

  /** Legacy instance-wide PATs are deliberately not adopted: there is no safe
   * owner to assign them to. The admin reconnects it from their own profile. */
  migrateLegacyToken(): void {
    // Kept as a compatibility hook for the module lifecycle. Importantly this
    // is a no-op: an unowned token must never become a credential for everyone.
  }

  list(): GitHubAccountRecord[] {
    return this.store.githubAccounts
      .list()
      .filter((row): row is GithubAccountRow & { ownerId: string } => row.ownerId !== null)
      .map(toRecord);
  }

  /** Validate the token, then insert (or replace the token of the same login). */
  async add(
    token: string,
    purposes: readonly GitHubPurpose[],
    ownerId: string,
    scope: GitHubAccountScope = 'all',
    workspaceIds: readonly string[] = [],
  ): Promise<GitHubAccountRecord> {
    const client = new GitHubClient(token);
    const viewer = await client.viewer();
    // The same GitHub login may be connected independently by different
    // Companion users. One user's connect flow must never replace another's.
    // Never let one user's connect flow overwrite another user's token.
    const existing = this.store.githubAccounts
      .list()
      .find((a) => a.login === viewer.login && a.ownerId === ownerId);
    if (existing) {
      this.store.githubAccounts.update(existing.id, { token, purposes, scope, workspaceIds });
      this.clients.set(existing.id, client);
      this.clearAccessCache(existing.id);
      // Ownership stays with whoever first connected the account.
      return toRecord({
        ...existing,
        login: viewer.login,
        purposes: [...purposes],
        scope,
        workspaceIds: [...workspaceIds],
        ownerId,
      });
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
    const row = this.store.githubAccounts
      .list()
      .find((a): a is GithubAccountRow & { ownerId: string } => a.id === id && a.ownerId !== null);
    if (!row) throw new Error(`unknown GitHub account: ${id}`);
    this.store.githubAccounts.update(id, fields);
    const updated = this.store.githubAccounts
      .list()
      .find((a): a is GithubAccountRow & { ownerId: string } => a.id === id && a.ownerId !== null) ?? row;
    return toRecord(updated);
  }

  /** The stored row (owner check for management gates). */
  row(id: string): GithubAccountRow | undefined {
    return this.store.githubAccounts.list().find((a) => a.id === id && a.ownerId !== null);
  }

  remove(id: string): void {
    this.store.repos.orphanWebhookRegistrationsForAccount(id);
    this.store.githubAccounts.delete(id);
    this.clients.delete(id);
    this.clearAccessCache(id);
  }

  /** A changed token/removal invalidates what we learned about the account's reach. */
  private clearAccessCache(accountId: string): void {
    for (const key of this.repoAccess.keys()) {
      if (key.startsWith(`${accountId}:`)) this.repoAccess.delete(key);
    }
  }

  clientFor(purpose: GitHubPurpose, ctx?: ResolveCtx): GitHubClient | null {
    const row = this.rowFor(purpose, ctx);
    return row ? this.clientOf(row) : null;
  }

  tokenFor(purpose: GitHubPurpose, ctx?: ResolveCtx): string | null {
    return this.rowFor(purpose, ctx)?.token ?? null;
  }

  loginFor(purpose: GitHubPurpose): string | null {
    const login = this.rowFor(purpose)?.login;
    return login ? login : null;
  }

  /**
   * Access-verified resolution for repo-bound work (clone/fetch/push, adding a
   * repo): walk the candidates in precedence order and return the first that
   * can actually SEE the repo, probing GitHub when several compete. `tried`
   * lists the logins that were rejected — feed it into user-facing errors.
   */
  async verifiedRowFor(
    purpose: GitHubPurpose,
    fullName: string,
    ctx?: Omit<ResolveCtx, 'repo'>,
  ): Promise<{ row: GithubAccountRow | null; tried: string[] }> {
    const candidates = this.candidatesFor(purpose, { ...ctx, repo: fullName });
    // A lone candidate is returned unprobed: whatever operation follows is its
    // own probe, and there is no better account to fall over to anyway.
    if (candidates.length <= 1) return { row: candidates[0] ?? null, tried: [] };
    const tried: string[] = [];
    for (const row of candidates) {
      if (await this.hasAccess(row, fullName)) return { row, tried };
      tried.push(row.login || row.id);
    }
    return { row: null, tried };
  }

  async verifiedTokenFor(
    purpose: GitHubPurpose,
    fullName: string,
    ctx?: Omit<ResolveCtx, 'repo'>,
  ): Promise<string | null> {
    const { row } = await this.verifiedRowFor(purpose, fullName, ctx);
    if (!row || !(await this.hasAccess(row, fullName))) return null;
    return row.token;
  }

  /** Access-verified client for a repo-bound API action. This is the write-side
   *  equivalent of verifiedTokenFor: a higher-precedence account that cannot
   *  see the repo must not turn a valid action into GitHub's opaque 404. */
  async verifiedClientFor(
    purpose: GitHubPurpose,
    fullName: string,
    ctx?: Omit<ResolveCtx, 'repo'>,
  ): Promise<{ client: GitHubClient | null; tried: string[] }> {
    const { row, tried } = await this.verifiedRowFor(purpose, fullName, ctx);
    if (!row) return { client: null, tried };
    // verifiedRowFor deliberately skips a redundant probe for a lone
    // candidate. A caller asking specifically for a verified client needs the
    // stronger contract even then (write actions must not leak GitHub's opaque
    // 404 when the selected account cannot see this repository).
    if (!(await this.hasAccess(row, fullName))) {
      return { client: null, tried: [...tried, row.login || row.id] };
    }
    return { client: this.clientOf(row), tried };
  }

  /**
   * Run a repo-bound GitHub action with account failover. Visibility alone is
   * not enough for writes: a fine-grained token may read the repo but GitHub
   * can still hide a write endpoint behind 403/404. Those credential failures
   * advance to the next eligible account; semantic failures (for example a
   * non-mergeable PR) remain authoritative and are returned to the caller.
   */
  async performForRepo<T>(
    purpose: GitHubPurpose,
    fullName: string,
    action: (client: GitHubClient) => Promise<T>,
    ctx?: Omit<ResolveCtx, 'repo'>,
  ): Promise<{ result: T | null; client: GitHubClient | null; tried: string[] }> {
    const candidates = this.candidatesFor(purpose, { ...ctx, repo: fullName });
    const tried: string[] = [];
    for (const row of candidates) {
      const label = row.login || row.id;
      if (!(await this.hasAccess(row, fullName))) {
        tried.push(label);
        continue;
      }
      const client = this.clientOf(row);
      try {
        return { result: await action(client), client, tried };
      } catch (err) {
        const credentialFailure =
          err instanceof GitHubError && [401, 403, 404].includes(err.status) && !/rate limit/i.test(err.message);
        if (!credentialFailure) throw err;
        tried.push(label);
      }
    }
    return { result: null, client: null, tried };
  }

  /**
   * The add-repo picker feed: repositories visible to the accounts the invoking
   * user may act with in this workspace (fetch purpose), deduped by full name
   * with the highest-precedence account winning, newest push first. Browsing is
   * best-effort — an account that errors (revoked token, rate limit) is skipped.
   */
  async repoCandidates(workspaceId: string): Promise<RepoCandidate[]> {
    // Cap the fan-out: beyond the top few accounts the union stops adding reach.
    const rows = this.candidatesFor('fetch', { workspaceId }).slice(0, 3);
    const listed = await Promise.all(
      rows.map(async (row) => {
        try {
          return { row, repos: await this.clientOf(row).viewerRepos() };
        } catch (err) {
          log.warn('listing repos failed for GitHub account', { login: row.login || row.id, err: String(err) });
          return { row, repos: [] };
        }
      }),
    );
    const seen = new Set<string>();
    const out: RepoCandidate[] = [];
    for (const { row, repos } of listed) {
      for (const r of repos) {
        if (r.archived || seen.has(r.full_name)) continue;
        seen.add(r.full_name);
        out.push({
          fullName: r.full_name,
          private: r.private,
          description: r.description,
          pushedAt: r.pushed_at ? Date.parse(r.pushed_at) : null,
          accountLogin: row.login || row.id,
        });
      }
    }
    return out.sort((a, b) => (b.pushedAt ?? 0) - (a.pushedAt ?? 0));
  }

  /** Does this account see the repo? Probes `GET /repos/:fullName`, TTL-cached. */
  private async hasAccess(row: GithubAccountRow, fullName: string): Promise<boolean> {
    const key = `${row.id}:${fullName}`;
    const cached = this.repoAccess.get(key);
    if (cached && Date.now() - cached.at < ACCESS_TTL_MS) return cached.ok;
    try {
      await this.clientOf(row).repo(fullName);
      this.repoAccess.set(key, { ok: true, at: Date.now() });
      return true;
    } catch (err) {
      // Authorization gates fail closed: an outage must not expose a cache
      // populated by someone else. Cache only definitive credential failures;
      // transient errors are retried on the next request.
      const definitive =
        err instanceof GitHubError && [401, 403, 404].includes(err.status) && !/rate limit/i.test(err.message);
      if (definitive) {
        this.repoAccess.set(key, { ok: false, at: Date.now() });
        return false;
      }
      return false;
    }
  }

  /** The client for an already-resolved row (e.g. the one verifiedRowFor returned). */
  clientOf(row: GithubAccountRow): GitHubClient {
    let client = this.clients.get(row.id);
    if (!client) {
      client = new GitHubClient(row.token);
      this.clients.set(row.id, client);
    }
    return client;
  }

  private rowFor(purpose: GitHubPurpose, ctx?: ResolveCtx): GithubAccountRow | undefined {
    const candidates = this.candidatesFor(purpose, ctx);
    if (!ctx?.repo) return candidates[0];
    // Sync paths can't probe, but they can respect what probes already learned:
    // skip candidates known (cached) to lack access to this repo.
    const repo = ctx.repo;
    const notKnownBad = (r: GithubAccountRow): boolean => {
      const cached = this.repoAccess.get(`${r.id}:${repo}`);
      return !cached || Date.now() - cached.at >= ACCESS_TTL_MS || cached.ok;
    };
    return candidates.find(notKnownBad);
  }

  /**
   * Every personal account the current Companion profile may use, in
   * precedence order. Purpose, owner, and workspace selection are hard
   * boundaries on every path, including explicit account selection.
   */
  private candidatesFor(purpose: GitHubPurpose, ctx?: ResolveCtx): GithubAccountRow[] {
    const rows = this.store.githubAccounts.list();
    const workspaceIds = ctx?.workspaceId
      ? [ctx.workspaceId]
      : ctx?.repo
        ? this.store.repos.workspaceIds(ctx.repo)
        : [];
    // An explicit null means system-owned work and must not inherit a request
    // that happened to enqueue it. Omission alone falls back to the invoker.
    const username = ctx && 'username' in ctx ? ctx.username : (currentUser()?.username ?? null);
    if (!username) return [];
    const eligibleHere = (r: GithubAccountRow): boolean =>
      r.ownerId === username &&
      r.purposes.includes(purpose) &&
      (r.scope === 'all' || workspaceIds.some((id) => r.workspaceIds.includes(id)));

    const ordered: GithubAccountRow[] = [];

    // 1. Explicit per-action account override — only if the caller may use it.
    if (ctx?.accountId) {
      const explicit = rows.find((r) => r.id === ctx.accountId && eligibleHere(r));
      // Explicit selection is fail-closed. An ineligible account must not
      // silently fall through to a more privileged credential.
      return explicit ? [explicit] : [];
    }

    // 2. The invoking user's own account, if it holds the purpose and is
    //    eligible here — a maintainer acts as themselves when they've connected.
    ordered.push(...rows.filter(eligibleHere));

    // Dedupe, keeping the first (highest-precedence) occurrence.
    const seen = new Set<string>();
    return ordered.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
  }
}

function toRecord(r: GithubAccountRow & { ownerId: string }): GitHubAccountRecord {
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
