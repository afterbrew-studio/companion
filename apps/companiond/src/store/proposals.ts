import type Database from 'better-sqlite3';
import type { ProposalAnalysis, ProposalRecord } from '@companion/contract';
import { safeParse } from './util.js';

/** Change proposals and their analyze/implement lifecycle. */
export class ProposalsStore {
  constructor(private readonly db: Database.Database) {}

  insert(p: ProposalRecord): void {
    this.db
      .prepare(
        `INSERT INTO proposals (id, repo, title, body, status, analysis, analysis_run_id, implement_run_id, branch, pr_url, created_at, updated_at)
         VALUES (@id, @repo, @title, @body, @status, @analysis, @analysisRunId, @implementRunId, @branch, @prUrl, @createdAt, @updatedAt)`,
      )
      .run({ ...p, analysis: p.analysis ? JSON.stringify(p.analysis) : null });
  }

  update(
    id: string,
    fields: Partial<{
      status: ProposalRecord['status'];
      analysis: ProposalAnalysis | null;
      analysisRunId: string;
      implementRunId: string;
      branch: string;
      prUrl: string;
    }>,
  ): void {
    const current = this.get(id);
    if (!current) return;
    const next = { ...current, ...fields, updatedAt: Date.now() };
    this.db
      .prepare(
        `UPDATE proposals SET status = @status, analysis = @analysis, analysis_run_id = @analysisRunId,
         implement_run_id = @implementRunId, branch = @branch, pr_url = @prUrl, updated_at = @updatedAt WHERE id = @id`,
      )
      .run({
        id,
        status: next.status,
        analysis: next.analysis ? JSON.stringify(next.analysis) : null,
        analysisRunId: next.analysisRunId,
        implementRunId: next.implementRunId,
        branch: next.branch,
        prUrl: next.prUrl,
        updatedAt: next.updatedAt,
      });
  }

  get(id: string): ProposalRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM proposals WHERE id = ?`).get(id) as ProposalRow | undefined;
    return row ? proposalRowToRecord(row) : undefined;
  }

  list(): ProposalRecord[] {
    const rows = this.db.prepare(`SELECT * FROM proposals ORDER BY created_at DESC`).all() as ProposalRow[];
    return rows.map(proposalRowToRecord);
  }

  listWorkspace(workspaceId: string): ProposalRecord[] {
    const rows = this.db
      .prepare(
        `SELECT p.* FROM proposals p JOIN repos r ON r.full_name = p.repo
         WHERE r.workspace_id = ? ORDER BY p.created_at DESC`,
      )
      .all(workspaceId) as ProposalRow[];
    return rows.map(proposalRowToRecord);
  }

  /**
   * Boot sweep: an 'analyzing' proposal whose one-shot driver died with the
   * previous daemon process would dangle forever — put it back to draft so
   * the Analyze action is available again.
   */
  resetDangling(): number {
    const result = this.db
      .prepare(`UPDATE proposals SET status = 'draft', updated_at = ? WHERE status = 'analyzing'`)
      .run(Date.now());
    return result.changes;
  }
}

interface ProposalRow {
  id: string;
  repo: string;
  title: string;
  body: string;
  status: ProposalRecord['status'];
  analysis: string | null;
  analysis_run_id: string | null;
  implement_run_id: string | null;
  branch: string | null;
  pr_url: string | null;
  created_at: number;
  updated_at: number;
}

function proposalRowToRecord(row: ProposalRow): ProposalRecord {
  return {
    id: row.id,
    repo: row.repo,
    title: row.title,
    body: row.body,
    status: row.status,
    analysis: row.analysis ? safeParse<ProposalAnalysis | null>(row.analysis, null) : null,
    analysisRunId: row.analysis_run_id,
    implementRunId: row.implement_run_id,
    branch: row.branch,
    prUrl: row.pr_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
