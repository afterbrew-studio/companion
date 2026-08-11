import type { Database } from '@moxxy/companion-sdk/server';
import type { ReportRecord } from '../contract/index.js';

/** A stable keyset cursor into the created_at DESC, id DESC report feed. */
export interface ReportCursor {
  readonly createdAt: number;
  readonly id: string;
}

/**
 * The viewer's report visibility, resolved to SQL. `accessibleWorkspaceIds`
 * is the workspace-membership scope (public + member); repo-scoped legacy rows
 * follow their repo's workspaces through code's published v_repos view.
 */
export interface ReportScope {
  readonly username: string;
  readonly accessibleWorkspaceIds: readonly string[];
}

/** Generated reports: digests, stale sweeps, ci-analysis and friends. */
export class ReportsStore {
  constructor(private readonly db: Database) {}

  insert(r: ReportRecord): void {
    this.db
      .prepare(
        `INSERT INTO reports (id, workspace_id, repo, issue_number, kind, title, body, created_at)
         VALUES (@id, @workspaceId, @repo, @issueNumber, @kind, @title, @body, @createdAt)`,
      )
      .run(r);
  }

  list(limit = 100): ReportRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM reports ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as ReportRow[];
    return rows.map(reportRowToRecord);
  }

  /**
   * One page of the viewer's reports, access scope applied IN the query so a
   * user whose visible rows are older than the global newest window still
   * reaches them by paging. The predicate mirrors the route's old JS filter:
   * workspace-scoped rows follow workspace access, unscoped legacy briefings
   * stay hidden, repo-scoped rows follow the repo's workspace visibility or
   * membership, and rows with neither scope are instance-wide.
   */
  listPage(opts: {
    readonly limit: number;
    readonly before?: ReportCursor;
    /** Omitted = unrestricted (internal callers). */
    readonly scope?: ReportScope;
  }): ReportRecord[] {
    const build = (repoProbe: boolean): { sql: string; params: Array<string | number> } => {
      const clauses: string[] = [];
      const params: Array<string | number> = [];
      if (opts.scope) {
        const ids = opts.scope.accessibleWorkspaceIds;
        const workspaceIn = ids.length > 0 ? `workspace_id IN (${ids.map(() => '?').join(', ')})` : '0';
        const repoAccess = repoProbe
          ? `EXISTS (
              SELECT 1 FROM v_repos vr JOIN workspaces w ON w.id = vr.workspace_id
               WHERE vr.full_name = reports.repo
                 AND (w.visibility = 'public' OR EXISTS (
                   SELECT 1 FROM workspace_members m WHERE m.workspace_id = w.id AND m.username = ?)))`
          : '0';
        clauses.push(`(
          (workspace_id IS NOT NULL AND ${workspaceIn})
          OR (workspace_id IS NULL AND kind <> 'briefing' AND (repo IS NULL OR ${repoAccess}))
        )`);
        params.push(...ids);
        if (repoProbe) params.push(opts.scope.username);
      }
      if (opts.before) {
        clauses.push('(created_at < ? OR (created_at = ? AND id < ?))');
        params.push(opts.before.createdAt, opts.before.createdAt, opts.before.id);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      return { sql: `SELECT * FROM reports ${where} ORDER BY created_at DESC, id DESC LIMIT ?`, params };
    };
    try {
      const { sql, params } = build(true);
      return (this.db.prepare(sql).all(...params, opts.limit) as ReportRow[]).map(reportRowToRecord);
    } catch {
      // code's v_repos view is gone (module uninstalled): there is no scope to
      // prove for repo rows, so they fail closed — same as canAccessRepo.
      const { sql, params } = build(false);
      return (this.db.prepare(sql).all(...params, opts.limit) as ReportRow[]).map(reportRowToRecord);
    }
  }

  /** Latest report of a kind for a specific issue/PR (ci-analysis lookups). */
  latestFor(repo: string, issueNumber: number, kind: ReportRecord['kind']): ReportRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM reports WHERE repo = ? AND issue_number = ? AND kind = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(repo, issueNumber, kind) as ReportRow | undefined;
    return row ? reportRowToRecord(row) : null;
  }

  /**
   * Delete reports older than the window. Bounded per sweep so a table that
   * grew for years cannot lock the database; the daily job catches up.
   */
  prune(olderThanMs: number, maxRows = 20_000): number {
    return this.db
      .prepare(
        `DELETE FROM reports WHERE id IN (
           SELECT id FROM reports WHERE created_at < ? ORDER BY created_at LIMIT ?)`,
      )
      .run(Date.now() - olderThanMs, maxRows).changes;
  }
}

interface ReportRow {
  id: string;
  workspace_id: string | null;
  repo: string | null;
  issue_number: number | null;
  kind: ReportRecord['kind'];
  title: string;
  body: string;
  created_at: number;
}

function reportRowToRecord(row: ReportRow): ReportRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    repo: row.repo,
    issueNumber: row.issue_number,
    kind: row.kind,
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
  };
}
