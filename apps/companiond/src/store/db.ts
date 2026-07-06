import Database from 'better-sqlite3';
import type { RunKind, RunRecord, RunStatus } from '@companion/contract';
import { paths } from '../config.js';

/**
 * Companion's domain store. The runs table is the source of truth for run
 * lifecycle (gateway processes are cattle; rows are not).
 */
export class Store {
  private readonly db: Database.Database;

  constructor(file = paths.db()) {
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id            TEXT PRIMARY KEY,
        kind          TEXT NOT NULL,
        status        TEXT NOT NULL,
        title         TEXT NOT NULL,
        cwd           TEXT NOT NULL,
        repo          TEXT,
        issue_number  INTEGER,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        input_tokens  INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        outcome       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
    `);
  }

  close(): void {
    this.db.close();
  }

  // ---------- runs ------------------------------------------------------------

  insertRun(run: Omit<RunRecord, 'live'>): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, kind, status, title, cwd, repo, issue_number, created_at, updated_at, input_tokens, output_tokens, outcome)
         VALUES (@id, @kind, @status, @title, @cwd, @repo, @issueNumber, @createdAt, @updatedAt, @inputTokens, @outputTokens, @outcome)`,
      )
      .run(run);
  }

  updateRunStatus(id: string, status: RunStatus, outcome?: string | null): void {
    this.db
      .prepare(
        `UPDATE runs SET status = ?, outcome = COALESCE(?, outcome), updated_at = ? WHERE id = ?`,
      )
      .run(status, outcome ?? null, Date.now(), id);
  }

  addRunUsage(id: string, inputTokens: number, outputTokens: number): void {
    this.db
      .prepare(
        `UPDATE runs SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, updated_at = ? WHERE id = ?`,
      )
      .run(inputTokens, outputTokens, Date.now(), id);
  }

  getRun(id: string): RunRow | undefined {
    return this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as RunRow | undefined;
  }

  listRuns(limit = 200): RunRow[] {
    return this.db
      .prepare(`SELECT * FROM runs ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as RunRow[];
  }

  /** Boot-time sweep: any run left 'running'/'provisioning' died with the daemon. */
  markInterruptedRuns(): number {
    const result = this.db
      .prepare(
        `UPDATE runs SET status = 'interrupted', updated_at = ? WHERE status IN ('running', 'provisioning', 'queued')`,
      )
      .run(Date.now());
    return result.changes;
  }
}

export interface RunRow {
  id: string;
  kind: RunKind;
  status: RunStatus;
  title: string;
  cwd: string;
  repo: string | null;
  issue_number: number | null;
  created_at: number;
  updated_at: number;
  input_tokens: number;
  output_tokens: number;
  outcome: string | null;
}

export function rowToRun(row: RunRow, live: boolean): RunRecord {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    title: row.title,
    cwd: row.cwd,
    repo: row.repo,
    issueNumber: row.issue_number,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    live,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    outcome: row.outcome,
  };
}
