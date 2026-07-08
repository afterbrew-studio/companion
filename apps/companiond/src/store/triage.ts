import type Database from 'better-sqlite3';
import type { TriageResult, TriageVerdict } from '@companion/contract';
import { safeParse } from './util.js';

/** AI triage verdicts per issue; the latest row per issue wins. */
export class TriageStore {
  constructor(private readonly db: Database.Database) {}

  insert(t: TriageResult): void {
    this.db
      .prepare(
        `INSERT INTO triage_results (id, repo, issue_number, run_id, status, verdict, error, created_at)
         VALUES (@id, @repo, @issueNumber, @runId, @status, @verdict, @error, @createdAt)`,
      )
      .run({ ...t, verdict: t.verdict ? JSON.stringify(t.verdict) : null });
  }

  update(id: string, status: TriageResult['status'], verdict?: TriageVerdict | null, error?: string | null): void {
    this.db
      .prepare(
        `UPDATE triage_results SET status = ?, verdict = COALESCE(?, verdict), error = COALESCE(?, error) WHERE id = ?`,
      )
      .run(status, verdict ? JSON.stringify(verdict) : null, error ?? null, id);
  }

  latest(repo: string, issueNumber: number): TriageResult | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM triage_results WHERE repo = ? AND issue_number = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(repo, issueNumber) as TriageRow | undefined;
    return row ? triageRowToResult(row) : undefined;
  }

  list(repo: string, status?: TriageResult['status']): TriageResult[] {
    const rows = (
      status
        ? this.db.prepare(`SELECT * FROM triage_results WHERE repo = ? AND status = ? ORDER BY created_at DESC`).all(repo, status)
        : this.db.prepare(`SELECT * FROM triage_results WHERE repo = ? ORDER BY created_at DESC`).all(repo)
    ) as TriageRow[];
    return rows.map(triageRowToResult);
  }

  /** Pending triage verdicts across a workspace's repos — used by the digest/briefing. */
  listWorkspacePending(workspaceId: string): TriageResult[] {
    const rows = this.db
      .prepare(
        `SELECT t.* FROM triage_results t JOIN repos r ON r.full_name = t.repo
         WHERE r.workspace_id = ? AND t.status = 'pending' ORDER BY t.created_at DESC`,
      )
      .all(workspaceId) as TriageRow[];
    return rows.map(triageRowToResult);
  }

  latestByIssue(repo: string): Map<number, TriageResult['status']> {
    const rows = this.db
      .prepare(
        `SELECT issue_number, status FROM triage_results t1 WHERE repo = ?
         AND created_at = (SELECT MAX(created_at) FROM triage_results t2 WHERE t2.repo = t1.repo AND t2.issue_number = t1.issue_number)`,
      )
      .all(repo) as Array<{ issue_number: number; status: TriageResult['status'] }>;
    return new Map(rows.map((r) => [r.issue_number, r.status]));
  }
}

interface TriageRow {
  id: string;
  repo: string;
  issue_number: number;
  run_id: string;
  status: TriageResult['status'];
  verdict: string | null;
  error: string | null;
  created_at: number;
}

function triageRowToResult(row: TriageRow): TriageResult {
  return {
    id: row.id,
    repo: row.repo,
    issueNumber: row.issue_number,
    runId: row.run_id,
    status: row.status,
    verdict: row.verdict ? safeParse<TriageVerdict | null>(row.verdict, null) : null,
    error: row.error,
    createdAt: row.created_at,
  };
}
