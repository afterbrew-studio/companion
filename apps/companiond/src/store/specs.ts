import type Database from 'better-sqlite3';
import type { SpecRecord } from '@companion/contract';

/** Specs — drafted or AI-generated design documents per repo. */
export class SpecsStore {
  constructor(private readonly db: Database.Database) {}

  insert(s: SpecRecord): void {
    this.db
      .prepare(
        `INSERT INTO specs (id, repo, title, content, status, source, storage, path, generate_run_id, drift_note, created_at, updated_at)
         VALUES (@id, @repo, @title, @content, @status, @source, @storage, @path, @generateRunId, @driftNote, @createdAt, @updatedAt)`,
      )
      .run({ ...s });
  }

  update(
    id: string,
    fields: Partial<{
      title: string;
      content: string;
      status: SpecRecord['status'];
      storage: SpecRecord['storage'];
      path: string | null;
      generateRunId: string | null;
      driftNote: string | null;
    }>,
  ): void {
    const current = this.get(id);
    if (!current) return;
    const next = { ...current, ...fields, updatedAt: Date.now() };
    this.db
      .prepare(
        `UPDATE specs SET title = @title, content = @content, status = @status, storage = @storage,
         path = @path, generate_run_id = @generateRunId, drift_note = @driftNote, updated_at = @updatedAt WHERE id = @id`,
      )
      .run({
        id,
        title: next.title,
        content: next.content,
        status: next.status,
        storage: next.storage,
        path: next.path,
        generateRunId: next.generateRunId,
        driftNote: next.driftNote,
        updatedAt: next.updatedAt,
      });
  }

  get(id: string): SpecRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM specs WHERE id = ?`).get(id) as SpecRow | undefined;
    return row ? specRowToRecord(row) : undefined;
  }

  remove(id: string): void {
    this.db.prepare(`DELETE FROM specs WHERE id = ?`).run(id);
  }

  listWorkspace(workspaceId: string): SpecRecord[] {
    const rows = this.db
      .prepare(
        `SELECT s.* FROM specs s JOIN repos r ON r.full_name = s.repo
         WHERE r.workspace_id = ? ORDER BY s.updated_at DESC`,
      )
      .all(workspaceId) as SpecRow[];
    return rows.map(specRowToRecord);
  }

  /** Boot sweep: a 'generating' spec whose one-shot driver died dangles — fail it. */
  resetDangling(): number {
    const result = this.db
      .prepare(`UPDATE specs SET status = 'failed', updated_at = ? WHERE status = 'generating'`)
      .run(Date.now());
    return result.changes;
  }
}

interface SpecRow {
  id: string;
  repo: string;
  title: string;
  content: string;
  status: SpecRecord['status'];
  source: SpecRecord['source'];
  storage: SpecRecord['storage'];
  path: string | null;
  generate_run_id: string | null;
  drift_note: string | null;
  created_at: number;
  updated_at: number;
}

function specRowToRecord(row: SpecRow): SpecRecord {
  return {
    id: row.id,
    repo: row.repo,
    title: row.title,
    content: row.content,
    status: row.status,
    source: row.source,
    storage: row.storage,
    path: row.path,
    generateRunId: row.generate_run_id,
    driftNote: row.drift_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
