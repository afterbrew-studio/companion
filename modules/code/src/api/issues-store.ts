import { likeArg, safeParse, type Database } from '@moxxy/companion-sdk/server';
import type { IssueListRecord, IssueRecord, TriageResult } from '../contract/index.js';
import type { GithubAccountsStore } from './github-accounts-store.js';
import type { TriageStore } from './triage-store.js';

/**
 * Issue sync cache — GitHub stays authoritative; we never mutate the cache
 * except from sync or an applied action.
 */
export class IssuesStore {
  constructor(
    private readonly db: Database,
    private readonly triage: TriageStore,
    private readonly githubAccounts: GithubAccountsStore,
  ) {}

  upsert(issue: Omit<IssueRecord, 'triage'>): void {
    this.db
      .prepare(
        `INSERT INTO issues (repo, number, title, body, state, labels, author, assignees, comments, url, created_at, updated_at, closed_at)
         VALUES (@repo, @number, @title, @body, @state, @labels, @author, @assignees, @comments, @url, @createdAt, @updatedAt, @closedAt)
         ON CONFLICT(repo, number) DO UPDATE SET
           title = excluded.title, body = excluded.body, state = excluded.state,
           labels = excluded.labels, author = excluded.author, assignees = excluded.assignees,
           comments = excluded.comments, url = excluded.url, updated_at = excluded.updated_at,
           closed_at = excluded.closed_at`,
      )
      .run({
        ...issue,
        labels: JSON.stringify(issue.labels),
        assignees: JSON.stringify(issue.assignees),
      });
  }

  list(repo: string, state?: 'open' | 'closed'): IssueRecord[] {
    const rows = (
      state
        ? this.db.prepare(`SELECT * FROM issues WHERE repo = ? AND state = ? ORDER BY number DESC`).all(repo, state)
        : this.db.prepare(`SELECT * FROM issues WHERE repo = ? ORDER BY number DESC`).all(repo)
    ) as IssueRow[];
    const triage = this.triage.latestByIssue(repo);
    return rows.map((row) => issueRowToRecord(row, triage.get(row.number) ?? null));
  }

  count(repo: string, state?: 'open' | 'closed'): number {
    const row = (state
      ? this.db.prepare(`SELECT COUNT(*) AS n FROM issues WHERE repo = ? AND state = ?`).get(repo, state)
      : this.db.prepare(`SELECT COUNT(*) AS n FROM issues WHERE repo = ?`).get(repo)) as { n: number };
    return row.n;
  }

  /** Repository cards need all badges together; one grouped query avoids an
   * N+1 count for every repo in a large workspace. */
  openCounts(repos: readonly string[]): Map<string, number> {
    const unique = [...new Set(repos)];
    if (unique.length === 0) return new Map();
    const rows = this.db
      .prepare(
        `SELECT repo, COUNT(*) AS n FROM issues
         WHERE state = 'open' AND repo IN (SELECT value FROM json_each(?))
         GROUP BY repo`,
      )
      .all(JSON.stringify(unique)) as Array<{ repo: string; n: number }>;
    return new Map(rows.map((row) => [row.repo, row.n]));
  }

  get(repo: string, number: number): IssueRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM issues WHERE repo = ? AND number = ?`).get(repo, number) as
      | IssueRow
      | undefined;
    if (!row) return undefined;
    const triage = this.triage.latest(repo, number);
    return issueRowToRecord(row, triage?.status ?? null);
  }

  /** Issues whose updated_at is older than `days` days (open only). */
  listStale(repo: string, days: number): IssueRecord[] {
    const cutoff = Date.now() - days * 86_400_000;
    const rows = this.db
      .prepare(`SELECT * FROM issues WHERE repo = ? AND state = 'open' AND updated_at < ? ORDER BY updated_at`)
      .all(repo, cutoff) as IssueRow[];
    return rows.map((row) => issueRowToRecord(row, null));
  }

  listSince(repo: string, since: number): IssueRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM issues WHERE repo = ? AND created_at >= ? ORDER BY number DESC`)
      .all(repo, since) as IssueRow[];
    return rows.map((row) => issueRowToRecord(row, null));
  }

  listWorkspace(workspaceId: string, state?: 'open' | 'closed'): IssueRecord[] {
    const rows = (
      state
        ? this.db
            .prepare(
              `SELECT i.* FROM issues i JOIN v_repos r ON r.full_name = i.repo
               WHERE r.workspace_id = ? AND i.state = ? ORDER BY i.updated_at DESC`,
            )
            .all(workspaceId, state)
        : this.db
            .prepare(
              `SELECT i.* FROM issues i JOIN v_repos r ON r.full_name = i.repo
               WHERE r.workspace_id = ? ORDER BY i.updated_at DESC`,
            )
            .all(workspaceId)
    ) as IssueRow[];
    const triageByRepo = new Map<string, Map<number, TriageResult['status']>>();
    return rows.map((row) => {
      let map = triageByRepo.get(row.repo);
      if (!map) {
        map = this.triage.latestByIssue(row.repo);
        triageByRepo.set(row.repo, map);
      }
      return issueRowToRecord(row, map.get(row.number) ?? null);
    });
  }

  /** Paged/filtered issues with per-state counts (for tab chips). */
  listWorkspacePaged(
    workspaceId: string,
    state: 'open' | 'closed' | undefined,
    opts: {
      q?: string;
      repo?: string;
      author?: string;
      assignee?: string;
      label?: string;
      /** Latest triage verdict status for the issue. */
      triage?: 'running' | 'pending' | 'applied' | 'dismissed';
      limit?: number;
      offset?: number;
      accessibleRepos?: readonly string[];
      myLogins?: readonly string[];
      includeFacets?: boolean;
    },
  ): {
    issues: IssueListRecord[];
    total: number;
    counts: { open: number; closed: number };
    facets: { authors: string[]; assignees: string[]; labels: string[] };
  } {
    const where: string[] = ['r.workspace_id = ?'];
    const args: unknown[] = [workspaceId];
    const accessibleReposJson = opts.accessibleRepos?.length
      ? JSON.stringify([...new Set(opts.accessibleRepos)])
      : null;
    if (opts.accessibleRepos) {
      where.push(accessibleReposJson ? `i.repo IN (SELECT value FROM json_each(?))` : '1 = 0');
      if (accessibleReposJson) args.push(accessibleReposJson);
    }
    if (opts.repo) {
      where.push('i.repo = ?');
      args.push(opts.repo);
    }
    if (opts.author === '__me') {
      const mine = [...(opts.myLogins ?? this.githubAccounts.logins())];
      where.push(mine.length > 0 ? `i.author IN (${mine.map(() => '?').join(', ')})` : '1 = 0');
      args.push(...mine);
    } else if (opts.author) {
      where.push('i.author = ?');
      args.push(opts.author);
    }
    if (opts.assignee === '__none') {
      where.push(`i.assignees = '[]'`);
    } else if (opts.assignee === '__me') {
      const mine = [...(opts.myLogins ?? this.githubAccounts.logins())];
      where.push(
        mine.length > 0
          ? `EXISTS (SELECT 1 FROM json_each(i.assignees) WHERE json_each.value IN (${mine.map(() => '?').join(', ')}))`
          : '1 = 0',
      );
      args.push(...mine);
    } else if (opts.assignee) {
      where.push(`EXISTS (SELECT 1 FROM json_each(i.assignees) WHERE json_each.value = ?)`);
      args.push(opts.assignee);
    }
    if (opts.label) {
      where.push(`EXISTS (SELECT 1 FROM json_each(i.labels) WHERE json_each.value = ?)`);
      args.push(opts.label);
    }
    if (opts.triage) {
      // The latest triage verdict for this issue is in that status.
      where.push(
        `EXISTS (SELECT 1 FROM triage_results tv
                 WHERE tv.repo = i.repo AND tv.issue_number = i.number AND tv.status = ?
                   AND tv.created_at = (SELECT MAX(created_at) FROM triage_results tv2
                                        WHERE tv2.repo = tv.repo AND tv2.issue_number = tv.issue_number))`,
      );
      args.push(opts.triage);
    }
    if (opts.q) {
      where.push(`(i.title LIKE ? ESCAPE '\\' OR i.labels LIKE ? ESCAPE '\\' OR CAST(i.number AS TEXT) = ?)`);
      const like = likeArg(opts.q);
      args.push(like, like, opts.q.replace(/^#/, ''));
    }
    const base = `FROM issues i JOIN v_repos r ON r.full_name = i.repo WHERE ${where.join(' AND ')}`;
    const counts = { open: 0, closed: 0 };
    for (const row of this.db.prepare(`SELECT i.state AS state, COUNT(*) AS n ${base} GROUP BY i.state`).all(...args) as Array<{ state: string; n: number }>) {
      if (row.state === 'open' || row.state === 'closed') counts[row.state] = row.n;
    }
    const stateCond = state ? ` AND i.state = ?` : '';
    const stateArgs = state ? [...args, state] : args;
    const limit = Math.min(Math.max(Number.isSafeInteger(opts.limit) ? opts.limit! : 50, 1), 100);
    const offset = Math.min(Math.max(Number.isSafeInteger(opts.offset) ? opts.offset! : 0, 0), 1_000_000);
    const rows = this.db
      .prepare(
        `SELECT i.repo, i.number, i.title, i.state, i.labels, i.author, i.assignees,
                i.comments, i.url, i.created_at, i.updated_at, i.closed_at
         ${base}${stateCond} ORDER BY i.updated_at DESC, i.repo, i.number DESC LIMIT ? OFFSET ?`,
      )
      .all(...stateArgs, limit, offset) as IssueListRow[];
    const triageByRepo = new Map<string, Map<number, TriageResult['status']>>();
    const pageNumbersByRepo = new Map<string, number[]>();
    for (const row of rows) {
      const numbers = pageNumbersByRepo.get(row.repo) ?? [];
      numbers.push(row.number);
      pageNumbersByRepo.set(row.repo, numbers);
    }
    const issues = rows.map((row) => {
      let map = triageByRepo.get(row.repo);
      if (!map) {
        map = this.triage.latestByIssue(row.repo, pageNumbersByRepo.get(row.repo));
        triageByRepo.set(row.repo, map);
      }
      return issueListRowToRecord(row, map.get(row.number) ?? null);
    });
    const total = state ? counts[state] : counts.open + counts.closed;
    const facetAccess = opts.accessibleRepos
      ? accessibleReposJson
        ? ` AND i.repo IN (SELECT value FROM json_each(?))`
        : ' AND 1 = 0'
      : '';
    const facetBase = `FROM issues i JOIN v_repos r ON r.full_name = i.repo WHERE r.workspace_id = ?${facetAccess}`;
    const facetArgs = accessibleReposJson ? [workspaceId, accessibleReposJson] : [workspaceId];
    const facets = opts.includeFacets === false
      ? { authors: [], assignees: [], labels: [] }
      : {
          authors: (this.db.prepare(`SELECT DISTINCT i.author AS v ${facetBase} AND i.author != '' ORDER BY 1 LIMIT 250`).all(...facetArgs) as Array<{ v: string }>).map((r) => r.v),
          assignees: (this.db.prepare(`SELECT DISTINCT json_each.value AS v ${facetBase.replace('WHERE', ', json_each(i.assignees) WHERE')} ORDER BY 1 LIMIT 250`).all(...facetArgs) as Array<{ v: string }>).map((r) => r.v),
          labels: (this.db.prepare(`SELECT DISTINCT json_each.value AS v ${facetBase.replace('WHERE', ', json_each(i.labels) WHERE')} ORDER BY 1 LIMIT 250`).all(...facetArgs) as Array<{ v: string }>).map((r) => r.v),
        };
    return { issues, total, counts, facets };
  }
}

interface IssueRow {
  repo: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string;
  author: string;
  assignees: string;
  comments: number;
  url: string;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

type IssueListRow = Omit<IssueRow, 'body'>;

function issueListRowToRecord(
  row: IssueListRow,
  triage: TriageResult['status'] | null,
): IssueListRecord {
  return {
    repo: row.repo,
    number: row.number,
    title: row.title,
    state: row.state,
    labels: safeParse(row.labels, []),
    author: row.author,
    assignees: safeParse(row.assignees, []),
    comments: row.comments,
    url: row.url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    triage: triage === 'failed' ? null : triage,
  };
}

function issueRowToRecord(row: IssueRow, triage: TriageResult['status'] | null): IssueRecord {
  return {
    ...issueListRowToRecord(row, triage),
    body: row.body,
  };
}
