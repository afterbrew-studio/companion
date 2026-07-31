import { likeArg, safeParse, type Database } from '@moxxy/companion-sdk/server';
import type { ChecksSnapshot, PrRecord } from '../contract/index.js';
import type { GithubAccountsStore } from './github-accounts-store.js';
import { reviewSignal, type LatestReviewSignal, type PrReviewsStore } from './pr-reviews-store.js';

/**
 * PR sync cache — GitHub stays authoritative; we never mutate the cache
 * except from sync or an applied action.
 */
export class PrsStore {
  constructor(
    private readonly db: Database,
    private readonly prReviews: PrReviewsStore,
    private readonly githubAccounts: GithubAccountsStore,
  ) {}

  upsert(pr: Omit<PrRecord, 'review' | 'reviewRisk' | 'checks' | 'reviewDecision' | 'mergeable' | 'mergeStateStatus'>): void {
    this.db
      .prepare(
        `INSERT INTO prs (repo, number, title, body, state, head_ref, head_sha, base_ref, draft, author, labels, assignees, url, created_at, updated_at, closed_at)
         VALUES (@repo, @number, @title, @body, @state, @headRef, @headSha, @baseRef, @isDraft, @author, @labelsJson, @assigneesJson, @url, @createdAt, @updatedAt, @closedAt)
         ON CONFLICT(repo, number) DO UPDATE SET
           title = excluded.title, body = excluded.body, state = excluded.state,
           head_ref = excluded.head_ref, base_ref = excluded.base_ref, draft = excluded.draft,
           author = excluded.author, labels = excluded.labels, assignees = excluded.assignees,
           url = excluded.url, updated_at = excluded.updated_at,
           closed_at = excluded.closed_at,
           checks = CASE WHEN excluded.head_sha IS NOT prs.head_sha THEN NULL ELSE prs.checks END,
           mergeable = CASE WHEN excluded.head_sha IS NOT prs.head_sha THEN NULL ELSE prs.mergeable END,
           merge_state = CASE WHEN excluded.head_sha IS NOT prs.head_sha THEN NULL ELSE prs.merge_state END,
           head_sha = excluded.head_sha`,
      )
      .run({
        repo: pr.repo,
        number: pr.number,
        title: pr.title,
        body: pr.body,
        state: pr.state,
        headRef: pr.headRef,
        headSha: pr.headSha,
        baseRef: pr.baseRef,
        isDraft: pr.draft ? 1 : 0,
        author: pr.author,
        labelsJson: JSON.stringify(pr.labels),
        assigneesJson: JSON.stringify(pr.assignees),
        url: pr.url,
        createdAt: pr.createdAt,
        updatedAt: pr.updatedAt,
        closedAt: pr.closedAt,
      });
  }

  /** Human review decision, harvested alongside the checks snapshot. */
  setReviewDecision(repo: string, number: number, decision: 'approved' | 'changes_requested' | null): void {
    this.db.prepare(`UPDATE prs SET review_decision = ? WHERE repo = ? AND number = ?`).run(decision, repo, number);
  }

  /** Conversation comment count, harvested from the issues feed during sync. */
  setComments(repo: string, number: number, comments: number): void {
    this.db.prepare(`UPDATE prs SET comments = ? WHERE repo = ? AND number = ?`).run(comments, repo, number);
  }

  /** GitHub's merge-cleanliness verdict; null = unknown (still computing). */
  setMergeable(repo: string, number: number, mergeable: boolean | null, mergeState?: string | null): void {
    this.db
      .prepare(`UPDATE prs SET mergeable = ?, merge_state = COALESCE(?, merge_state) WHERE repo = ? AND number = ?`)
      .run(mergeable === null ? null : mergeable ? 1 : 0, mergeState ?? null, repo, number);
  }

  /** Cache the latest CI snapshot for a PR (invalidated when head_sha moves). */
  setChecks(repo: string, number: number, snapshot: ChecksSnapshot): void {
    this.db
      .prepare(`UPDATE prs SET checks = ? WHERE repo = ? AND number = ?`)
      .run(JSON.stringify(snapshot), repo, number);
  }

  list(repo: string): PrRecord[] {
    const rows = this.db.prepare(`SELECT * FROM prs WHERE repo = ? ORDER BY number DESC`).all(repo) as PrRow[];
    const reviews = this.prReviews.latestByNumber(repo);
    return rows.map((r) => prRowToRecord(r, reviews.get(r.number) ?? null));
  }

  /**
   * Open PRs whose head is this commit. A check_run/status webhook names a SHA,
   * not a PR, so this is how a CI event finds what it invalidates. Open only:
   * a merged PR's checks are frozen and re-fetching them is wasted budget.
   */
  openByHeadSha(repo: string, headSha: string): PrRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM prs WHERE repo = ? AND head_sha = ? AND state = 'open'`)
      .all(repo, headSha) as PrRow[];
    const reviews = this.prReviews.latestByNumber(repo);
    return rows.map((r) => prRowToRecord(r, reviews.get(r.number) ?? null));
  }

  get(repo: string, number: number): PrRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM prs WHERE repo = ? AND number = ?`).get(repo, number) as
      | PrRow
      | undefined;
    if (!row) return undefined;
    return prRowToRecord(row, reviewSignal(this.prReviews.latest(repo, number)));
  }

  listWorkspace(workspaceId: string): PrRecord[] {
    const rows = this.db
      .prepare(
        `SELECT p.* FROM prs p JOIN v_repos r ON r.full_name = p.repo
         WHERE r.workspace_id = ? ORDER BY p.updated_at DESC`,
      )
      .all(workspaceId) as PrRow[];
    const reviewsByRepo = new Map<string, Map<number, LatestReviewSignal>>();
    return rows.map((row) => {
      let map = reviewsByRepo.get(row.repo);
      if (!map) {
        map = this.prReviews.latestByNumber(row.repo);
        reviewsByRepo.set(row.repo, map);
      }
      return prRowToRecord(row, map.get(row.number) ?? null);
    });
  }

  /** Paged/filtered PRs with per-state counts (for tab chips). */
  listWorkspacePaged(
    workspaceId: string,
    state: 'open' | 'merged' | 'closed' | undefined,
    opts: {
      q?: string;
      repo?: string;
      author?: string;
      assignee?: string;
      label?: string;
      decision?: 'approved' | 'changes_requested' | 'none';
      /** Latest AI review verdict status for the PR. */
      review?: 'pending' | 'applied' | 'dismissed';
      draft?: 'hide' | 'only';
      limit?: number;
      offset?: number;
      accessibleRepos?: readonly string[];
      myLogins?: readonly string[];
    },
  ): {
    prs: PrRecord[];
    total: number;
    counts: { open: number; merged: number; closed: number };
    facets: { authors: string[]; assignees: string[]; labels: string[] };
  } {
    const where: string[] = ['r.workspace_id = ?'];
    const args: unknown[] = [workspaceId];
    if (opts.accessibleRepos) {
      where.push(opts.accessibleRepos.length > 0 ? `p.repo IN (${opts.accessibleRepos.map(() => '?').join(', ')})` : '1 = 0');
      args.push(...opts.accessibleRepos);
    }
    if (opts.repo) {
      where.push('p.repo = ?');
      args.push(opts.repo);
    }
    if (opts.author === '__me') {
      const mine = [...(opts.myLogins ?? this.githubAccounts.logins())];
      where.push(mine.length > 0 ? `p.author IN (${mine.map(() => '?').join(', ')})` : '1 = 0');
      args.push(...mine);
    } else if (opts.author) {
      where.push('p.author = ?');
      args.push(opts.author);
    }
    if (opts.assignee === '__none') {
      where.push(`p.assignees = '[]'`);
    } else if (opts.assignee === '__me') {
      const mine = [...(opts.myLogins ?? this.githubAccounts.logins())];
      where.push(
        mine.length > 0
          ? `EXISTS (SELECT 1 FROM json_each(p.assignees) WHERE json_each.value IN (${mine.map(() => '?').join(', ')}))`
          : '1 = 0',
      );
      args.push(...mine);
    } else if (opts.assignee) {
      where.push(`EXISTS (SELECT 1 FROM json_each(p.assignees) WHERE json_each.value = ?)`);
      args.push(opts.assignee);
    }
    if (opts.label) {
      where.push(`EXISTS (SELECT 1 FROM json_each(p.labels) WHERE json_each.value = ?)`);
      args.push(opts.label);
    }
    if (opts.decision === 'none') {
      where.push('p.review_decision IS NULL');
    } else if (opts.decision) {
      where.push('p.review_decision = ?');
      args.push(opts.decision);
    }
    if (opts.review) {
      // The latest AI review verdict for this PR is in that status.
      where.push(
        `EXISTS (SELECT 1 FROM pr_reviews pv
                 WHERE pv.repo = p.repo AND pv.pr_number = p.number AND pv.status = ?
                   AND pv.created_at = (SELECT MAX(created_at) FROM pr_reviews pv2
                                        WHERE pv2.repo = pv.repo AND pv2.pr_number = pv.pr_number))`,
      );
      args.push(opts.review);
    }
    if (opts.draft === 'hide') where.push('p.draft = 0');
    else if (opts.draft === 'only') where.push('p.draft = 1');
    if (opts.q) {
      where.push(`(p.title LIKE ? ESCAPE '\\' OR p.author LIKE ? ESCAPE '\\' OR CAST(p.number AS TEXT) = ?)`);
      const like = likeArg(opts.q);
      args.push(like, like, opts.q.replace(/^#/, ''));
    }
    const base = `FROM prs p JOIN v_repos r ON r.full_name = p.repo WHERE ${where.join(' AND ')}`;
    const counts = { open: 0, merged: 0, closed: 0 };
    for (const row of this.db.prepare(`SELECT p.state AS state, COUNT(*) AS n ${base} GROUP BY p.state`).all(...args) as Array<{ state: string; n: number }>) {
      if (row.state === 'open' || row.state === 'merged' || row.state === 'closed') counts[row.state] = row.n;
    }
    const stateCond = state ? ` AND p.state = ?` : '';
    const stateArgs = state ? [...args, state] : args;
    const rows = this.db
      .prepare(`SELECT p.* ${base}${stateCond} ORDER BY p.updated_at DESC LIMIT ? OFFSET ?`)
      .all(...stateArgs, opts.limit ?? -1, opts.offset ?? 0) as PrRow[];
    const reviewsByRepo = new Map<string, Map<number, LatestReviewSignal>>();
    const prs = rows.map((row) => {
      let map = reviewsByRepo.get(row.repo);
      if (!map) {
        map = this.prReviews.latestByNumber(row.repo);
        reviewsByRepo.set(row.repo, map);
      }
      return prRowToRecord(row, map.get(row.number) ?? null);
    });
    const total = state ? counts[state] : counts.open + counts.merged + counts.closed;
    const facetAccess = opts.accessibleRepos
      ? opts.accessibleRepos.length > 0
        ? ` AND p.repo IN (${opts.accessibleRepos.map(() => '?').join(', ')})`
        : ' AND 1 = 0'
      : '';
    const facetBase = `FROM prs p JOIN v_repos r ON r.full_name = p.repo WHERE r.workspace_id = ?${facetAccess}`;
    const facetArgs = [workspaceId, ...(opts.accessibleRepos ?? [])];
    const facets = {
      authors: (this.db.prepare(`SELECT DISTINCT p.author AS v ${facetBase} AND p.author != '' ORDER BY 1`).all(...facetArgs) as Array<{ v: string }>).map((r) => r.v),
      assignees: (this.db.prepare(`SELECT DISTINCT json_each.value AS v ${facetBase.replace('WHERE', ', json_each(p.assignees) WHERE')} ORDER BY 1`).all(...facetArgs) as Array<{ v: string }>).map((r) => r.v),
      labels: (this.db.prepare(`SELECT DISTINCT json_each.value AS v ${facetBase.replace('WHERE', ', json_each(p.labels) WHERE')} ORDER BY 1`).all(...facetArgs) as Array<{ v: string }>).map((r) => r.v),
    };
    return { prs, total, counts, facets };
  }
}

interface PrRow {
  repo: string;
  number: number;
  title: string;
  body: string;
  state: string;
  head_ref: string;
  head_sha: string | null;
  base_ref: string;
  draft: number;
  author: string;
  labels: string;
  assignees: string;
  comments: number;
  review_decision: string | null;
  mergeable: number | null;
  merge_state: string | null;
  url: string;
  checks: string | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

function prRowToRecord(row: PrRow, review: LatestReviewSignal | null): PrRecord {
  return {
    repo: row.repo,
    number: row.number,
    title: row.title,
    body: row.body,
    state: row.state as PrRecord['state'],
    headRef: row.head_ref,
    headSha: row.head_sha,
    baseRef: row.base_ref,
    draft: row.draft === 1,
    author: row.author,
    labels: safeParse<string[]>(row.labels ?? '[]', []),
    assignees: safeParse<string[]>(row.assignees ?? '[]', []),
    comments: row.comments ?? 0,
    url: row.url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    review: review === null || review.status === 'failed' ? null : review.status,
    reviewRisk: review?.risk ?? null,
    reviewDecision:
      row.review_decision === 'approved' || row.review_decision === 'changes_requested' ? row.review_decision : null,
    mergeable: row.mergeable === null ? null : row.mergeable === 1,
    mergeStateStatus: (row.merge_state as PrRecord['mergeStateStatus']) ?? null,
    checks: row.checks ? safeParse<ChecksSnapshot | null>(row.checks, null) : null,
  };
}
