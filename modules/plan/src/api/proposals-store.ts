import { likeArg, safeParse, type Database } from '@moxxy/companion-sdk/server';
import type { ProposalAnalysis, ProposalListRecord, ProposalRecord } from '../contract/index.js';

/** Change proposals and their analyze/implement lifecycle. */
export class ProposalsStore {
  constructor(private readonly db: Database) {}

  insert(p: ProposalRecord): void {
    this.db
      .prepare(
        `INSERT INTO proposals (id, workspace_id, repo, title, body, status, analysis, analysis_run_id, implement_run_id, branch, pr_url, created_at, updated_at)
         VALUES (@id, @workspaceId, @repo, @title, @body, @status, @analysis, @analysisRunId, @implementRunId, @branch, @prUrl, @createdAt, @updatedAt)`,
      )
      .run({ ...p, analysis: p.analysis ? JSON.stringify(p.analysis) : null });
  }

  update(
    id: string,
    fields: Partial<{
      status: ProposalRecord['status'];
      analysis: ProposalAnalysis | null;
      analysisRunId: string | null;
      implementRunId: string | null;
      branch: string | null;
      prUrl: string | null;
      title: string;
      body: string;
    }>,
  ): void {
    const current = this.get(id);
    if (!current) return;
    const next = { ...current, ...fields, updatedAt: Date.now() };
    this.db
      .prepare(
        `UPDATE proposals SET title = @title, body = @body, status = @status, analysis = @analysis, analysis_run_id = @analysisRunId,
         implement_run_id = @implementRunId, branch = @branch, pr_url = @prUrl, updated_at = @updatedAt WHERE id = @id`,
      )
      .run({
        id,
        title: next.title,
        body: next.body,
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

  getByImplementRunId(
    runId: string,
  ): Pick<ProposalRecord, 'id' | 'status'> | undefined {
    const row = this.db
      .prepare(`SELECT id, status FROM proposals WHERE implement_run_id = ? LIMIT 1`)
      .get(runId) as Pick<ProposalRecord, 'id' | 'status'> | undefined;
    return row;
  }

  list(): ProposalRecord[] {
    const rows = this.db.prepare(`SELECT * FROM proposals ORDER BY created_at DESC`).all() as ProposalRow[];
    return rows.map(proposalRowToRecord);
  }

  listWorkspace(workspaceId: string): ProposalRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM proposals WHERE workspace_id = ? ORDER BY created_at DESC`,
      )
      .all(workspaceId) as ProposalRow[];
    return rows.map(proposalRowToRecord);
  }

  listWorkspacePage(
    workspaceId: string,
    opts: {
      readonly q?: string;
      readonly repo?: string;
      readonly status?: ProposalRecord['status'];
      readonly limit?: number;
      readonly offset?: number;
    } = {},
  ): { proposals: ProposalListRecord[]; total: number } {
    const where = ['workspace_id = ?'];
    const args: unknown[] = [workspaceId];
    if (opts.q) {
      where.push(`(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')`);
      args.push(likeArg(opts.q), likeArg(opts.q));
    }
    if (opts.repo) {
      where.push('repo = ?');
      args.push(opts.repo);
    }
    if (opts.status) {
      where.push('status = ?');
      args.push(opts.status);
    }
    const clause = `WHERE ${where.join(' AND ')}`;
    const total = (this.db
      .prepare(`SELECT COUNT(*) AS n FROM proposals ${clause}`)
      .get(...args) as { n: number }).n;
    const limit = Math.min(Math.max(Number.isSafeInteger(opts.limit) ? opts.limit! : 50, 1), 100);
    const offset = Math.max(Number.isSafeInteger(opts.offset) ? opts.offset! : 0, 0);
    const rows = this.db.prepare(`
      SELECT id, workspace_id, repo, title, SUBSTR(body, 1, 500) AS body_preview,
             LENGTH(body) AS body_length, status, analysis_run_id, implement_run_id,
             branch, pr_url,
             CASE WHEN analysis IS NOT NULL AND json_valid(analysis)
               THEN json_extract(analysis, '$.feasibility') ELSE NULL END AS analysis_feasibility,
             created_at, updated_at
      FROM proposals ${clause}
      ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
    `).all(...args, limit, offset) as ProposalListRow[];
    return { proposals: rows.map(proposalListRowToRecord), total };
  }

  /** Status-only projection for cross-module counters; never materialises body/analysis. */
  listStatusesByWorkspace(
    workspaceId: string,
  ): Array<{ readonly id: string; readonly status: ProposalRecord['status'] }> {
    return this.db
      .prepare(`SELECT id, status FROM proposals WHERE workspace_id = ?`)
      .all(workspaceId) as Array<{ id: string; status: ProposalRecord['status'] }>;
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
  workspace_id: string;
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

interface ProposalListRow {
  id: string;
  workspace_id: string;
  repo: string;
  title: string;
  body_preview: string;
  body_length: number;
  status: ProposalRecord['status'];
  analysis_feasibility: unknown;
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
    workspaceId: row.workspace_id,
    repo: row.repo,
    title: row.title,
    body: row.body,
    status: row.status,
    analysis: row.analysis ? normalizeProposalAnalysis(safeParse<unknown>(row.analysis, null)) : null,
    analysisRunId: row.analysis_run_id,
    implementRunId: row.implement_run_id,
    branch: row.branch,
    prUrl: row.pr_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function proposalListRowToRecord(row: ProposalListRow): ProposalListRecord {
  const feasibility = typeof row.analysis_feasibility === 'string'
    && ['low', 'medium', 'high'].includes(row.analysis_feasibility)
    ? row.analysis_feasibility as ProposalAnalysis['feasibility']
    : null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    repo: row.repo,
    title: row.title,
    bodyPreview: row.body_preview,
    bodyLength: row.body_length,
    status: row.status,
    analysisFeasibility: feasibility,
    analysisRunId: row.analysis_run_id,
    implementRunId: row.implement_run_id,
    branch: row.branch,
    prUrl: row.pr_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Old persisted analyses remain readable after richer planner fields landed. */
export function normalizeProposalAnalysis(value: unknown): ProposalAnalysis | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const strings = (key: string): string[] =>
    Array.isArray(record[key]) ? record[key].filter((entry): entry is string => typeof entry === 'string') : [];
  const feasibility = record.feasibility;
  if (typeof record.summary !== 'string' || !['low', 'medium', 'high'].includes(String(feasibility))) return null;
  return {
    summary: record.summary,
    feasibility: feasibility as ProposalAnalysis['feasibility'],
    steps: strings('steps'),
    touchedAreas: strings('touchedAreas'),
    risks: strings('risks'),
    architecture: strings('architecture'),
    dataModelAndMigrations: strings('dataModelAndMigrations'),
    apiAndUi: strings('apiAndUi'),
    authorizationPrivacySecurity: strings('authorizationPrivacySecurity'),
    tests: strings('tests'),
    dependencies: strings('dependencies'),
    costs: strings('costs'),
    mvp: strings('mvp'),
    later: strings('later'),
    openDecisions: strings('openDecisions'),
  };
}
