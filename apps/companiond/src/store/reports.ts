import type Database from 'better-sqlite3';
import type { ReportRecord } from '@companion/contract';

/** Generated reports: digests, stale sweeps, ci-analysis and friends. */
export class ReportsStore {
  constructor(private readonly db: Database.Database) {}

  insert(r: ReportRecord): void {
    this.db
      .prepare(
        `INSERT INTO reports (id, repo, issue_number, kind, title, body, created_at)
         VALUES (@id, @repo, @issueNumber, @kind, @title, @body, @createdAt)`,
      )
      .run(r);
  }

  list(limit = 100): ReportRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM reports ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as ReportRow[];
    return rows.map(reportRowToRecord);
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
}

interface ReportRow {
  id: string;
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
    repo: row.repo,
    issueNumber: row.issue_number,
    kind: row.kind,
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
  };
}
