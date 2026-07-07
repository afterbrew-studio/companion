import type { SpaServerMessage } from '@companion/contract';
import { log } from '../log.js';
import type { Store } from '../store/db.js';
import { GitHubClient, type GhIssue, type GhPull } from './client.js';

/**
 * Incremental GitHub → SQLite sync. GitHub stays authoritative; the cache
 * exists so the board renders instantly and agents can be prompted without
 * burning API calls. Poll cadence is slow (2 min) — webhooks are the fast path.
 */
export class GitHubSync {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = new Map<string, Promise<{ issues: number; prs: number }>>();
  /** Optional post-sync hook (checks refresh); injected to avoid a dep cycle. */
  onSynced: ((repo: string) => Promise<void>) | null = null;

  constructor(
    private readonly store: Store,
    private readonly client: () => GitHubClient | null,
    private readonly broadcast: (msg: SpaServerMessage) => void,
  ) {}

  start(intervalMs = 120_000): void {
    // First poll now, not one interval from now — a freshly booted daemon
    // should catch up without waiting or a manual sync.
    void this.syncAll().catch((err) => log.warn('initial sync failed', { err: String(err) }));
    this.timer = setInterval(() => {
      void this.syncAll().catch((err) => log.warn('sync tick failed', { err: String(err) }));
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async syncAll(): Promise<void> {
    for (const repo of this.store.listRepos()) {
      await this.syncRepo(repo.full_name).catch((err) =>
        log.warn(`sync failed for ${repo.full_name}`, { err: String(err) }),
      );
    }
  }

  /** Webhook fast path: the delivery carries the full issue — apply it now. */
  applyIssue(fullName: string, issue: GhIssue): void {
    this.store.upsertIssue(mapIssue(fullName, issue));
    this.broadcast({ t: 'issues.changed', repo: fullName });
  }

  /** Webhook fast path: the delivery carries the full PR — apply it now. */
  applyPull(fullName: string, pr: GhPull): void {
    this.store.upsertPr(mapPull(fullName, pr));
    this.broadcast({ t: 'prs.changed', repo: fullName });
  }

  async syncRepo(fullName: string): Promise<{ issues: number; prs: number }> {
    const client = this.client();
    if (!client) throw new Error('GitHub is not configured (set a PAT in Settings)');
    // Concurrent callers join the in-flight sync — returning a fake empty
    // result here would let automation run before the data actually landed.
    const existing = this.inFlight.get(fullName);
    if (existing) return existing;
    const run = this.doSync(fullName, client);
    this.inFlight.set(fullName, run);
    try {
      return await run;
    } finally {
      this.inFlight.delete(fullName);
    }
  }

  private async doSync(
    fullName: string,
    client: GitHubClient,
  ): Promise<{ issues: number; prs: number }> {
    const repoRow = this.store.getRepo(fullName);
    // Incremental: only issues updated since the last sync (minus a safety margin).
    const since = repoRow?.last_sync_at
      ? new Date(repoRow.last_sync_at - 5 * 60_000).toISOString()
      : undefined;

    const [issues, pulls] = await Promise.all([
      client.issues(fullName, since ? { since } : {}),
      client.pulls(fullName),
    ]);
    for (const pr of pulls) this.store.upsertPr(mapPull(fullName, pr));
    for (const item of issues) {
      // The issues feed interleaves PRs — those only contribute their
      // conversation comment count to the PR row.
      if (item.pull_request) this.store.setPrComments(fullName, item.number, item.comments);
      else this.store.upsertIssue(mapIssue(fullName, item));
    }
    this.store.setRepoSynced(fullName);
    if (issues.length > 0) this.broadcast({ t: 'issues.changed', repo: fullName });
    if (pulls.length > 0) this.broadcast({ t: 'prs.changed', repo: fullName });
    this.broadcast({ t: 'repos.changed' });
    if (this.onSynced) {
      void this.onSynced(fullName).catch((err) =>
        log.warn('post-sync hook failed', { repo: fullName, err: String(err) }),
      );
    }
    return { issues: issues.length, prs: pulls.length };
  }
}

function mapIssue(repo: string, issue: GhIssue) {
  return {
    repo,
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state,
    labels: issue.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean),
    author: issue.user?.login ?? '',
    assignees: (issue.assignees ?? []).map((a) => a.login),
    comments: issue.comments,
    url: issue.html_url,
    createdAt: Date.parse(issue.created_at),
    updatedAt: Date.parse(issue.updated_at),
    closedAt: issue.closed_at ? Date.parse(issue.closed_at) : null,
  };
}

function mapPull(repo: string, pr: GhPull) {
  return {
    repo,
    number: pr.number,
    title: pr.title,
    body: pr.body ?? '',
    state: (pr.merged_at ? 'merged' : pr.state) as 'open' | 'closed' | 'merged',
    headRef: pr.head.ref,
    headSha: pr.head.sha ?? null,
    baseRef: pr.base.ref,
    draft: pr.draft === true,
    author: pr.user?.login ?? '',
    labels: (pr.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean),
    assignees: (pr.assignees ?? []).map((a) => a.login),
    comments: 0, // harvested separately from the issues feed

    url: pr.html_url,
    createdAt: Date.parse(pr.created_at),
    updatedAt: Date.parse(pr.updated_at),
    closedAt: pr.closed_at ? Date.parse(pr.closed_at) : pr.merged_at ? Date.parse(pr.merged_at) : null,
  };
}
