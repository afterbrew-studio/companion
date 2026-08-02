import { safeParse, type Database } from '@moxxy/companion-sdk/server';
import type { TriageResult, TriageVerdict } from '../contract/index.js';
import { outcomeSql, toCounts, type OutcomeCounts } from './quality.js';

/** AI triage verdicts per issue; the latest row per issue wins. */
export class TriageStore {
  constructor(private readonly db: Database) {}

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

  setRun(id: string, runId: string): void {
    this.db.prepare(`UPDATE triage_results SET run_id = ? WHERE id = ? AND status = 'running'`).run(runId, id);
  }

  finish(id: string, status: 'pending' | 'failed', verdict: TriageVerdict | null, error: string | null): void {
    this.db
      .prepare(`UPDATE triage_results SET status = ?, verdict = ?, error = ? WHERE id = ? AND status = 'running'`)
      .run(status, verdict ? JSON.stringify(verdict) : null, error, id);
  }

  /** A process-local agent cannot still be running after this daemon booted. */
  failInterrupted(): string[] {
    const repos = this.db
      .prepare(`SELECT DISTINCT repo FROM triage_results WHERE status = 'running'`)
      .all() as Array<{ repo: string }>;
    this.db
      .prepare(
        `UPDATE triage_results
         SET status = 'failed', error = 'triage was interrupted by a daemon restart'
         WHERE status = 'running'`,
      )
      .run();
    return repos.map((row) => row.repo);
  }

  get(id: string): TriageResult | undefined {
    const row = this.db.prepare(`SELECT * FROM triage_results WHERE id = ?`).get(id) as TriageRow | undefined;
    return row ? triageRowToResult(row) : undefined;
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

  /** Outcome counts for one workspace's triage verdicts since a point in time. */
  outcomes(workspaceId: string, since: number): OutcomeCounts {
    return toCounts(
      this.db.prepare(outcomeSql('triage_results')).all(workspaceId, since) as Array<{ status: string; n: number }>,
    );
  }

  latestByIssue(repo: string, issueNumbers?: readonly number[]): Map<number, TriageResult['status']> {
    if (issueNumbers?.length === 0) return new Map();
    const numberClause = issueNumbers ? ` AND issue_number IN (${issueNumbers.map(() => '?').join(', ')})` : '';
    const rows = this.db
      .prepare(
        `SELECT issue_number, status FROM (
           SELECT issue_number, status,
                  ROW_NUMBER() OVER (PARTITION BY issue_number ORDER BY created_at DESC, id DESC) AS row_number
           FROM triage_results WHERE repo = ?${numberClause}
         ) WHERE row_number = 1`,
      )
      .all(repo, ...(issueNumbers ?? [])) as Array<{ issue_number: number; status: TriageResult['status'] }>;
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
