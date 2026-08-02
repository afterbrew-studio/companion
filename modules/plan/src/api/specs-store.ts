import { likeArg, type Database } from '@moxxy/companion-sdk/server';
import type { SpecListRecord, SpecRecord } from '../contract/index.js';

/** Specs — drafted or AI-generated design documents per repo. */
export class SpecsStore {
  constructor(private readonly db: Database) {}

  insert(s: SpecRecord): void {
    this.db
      .prepare(
        `INSERT INTO specs (id, workspace_id, repo, title, content, status, source, storage, path, generate_run_id, drift_note, created_at, updated_at)
         VALUES (@id, @workspaceId, @repo, @title, @content, @status, @source, @storage, @path, @generateRunId, @driftNote, @createdAt, @updatedAt)`,
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
        `SELECT * FROM specs WHERE workspace_id = ? ORDER BY updated_at DESC`,
      )
      .all(workspaceId) as SpecRow[];
    return rows.map(specRowToRecord);
  }

  /** Paged card projection; full markdown remains on get(). */
  listWorkspacePage(
    workspaceId: string,
    opts: {
      readonly q?: string;
      readonly repo?: string;
      readonly status?: SpecRecord['status'] | 'drifted';
      readonly source?: SpecRecord['source'];
      readonly storage?: SpecRecord['storage'];
      readonly limit?: number;
      readonly offset?: number;
    } = {},
  ): { specs: SpecListRecord[]; total: number } {
    const where = ['workspace_id = ?'];
    const args: unknown[] = [workspaceId];
    if (opts.q) {
      where.push(`(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')`);
      args.push(likeArg(opts.q), likeArg(opts.q));
    }
    if (opts.repo) {
      where.push('repo = ?');
      args.push(opts.repo);
    }
    if (opts.status === 'drifted') where.push('drift_note IS NOT NULL');
    else if (opts.status) {
      where.push('status = ?');
      args.push(opts.status);
    }
    if (opts.source) {
      where.push('source = ?');
      args.push(opts.source);
    }
    if (opts.storage) {
      where.push('storage = ?');
      args.push(opts.storage);
    }
    const clause = `WHERE ${where.join(' AND ')}`;
    const count = this.db.prepare(`SELECT COUNT(*) AS n FROM specs ${clause}`).get(...args) as { n: number };
    const limit = Math.min(Math.max(Number.isSafeInteger(opts.limit) ? opts.limit! : 50, 1), 100);
    const offset = Math.max(Number.isSafeInteger(opts.offset) ? opts.offset! : 0, 0);
    const rows = this.db
      .prepare(
        `SELECT id, workspace_id, repo, title, status, source, storage, path, generate_run_id,
                drift_note, LENGTH(content) AS content_length, created_at, updated_at
         FROM specs ${clause}
         ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset) as SpecListRow[];
    return { specs: rows.map(specListRowToRecord), total: count.n };
  }

  listRepo(repo: string): SpecRecord[] {
    const rows = this.db.prepare(`SELECT * FROM specs WHERE repo = ? ORDER BY updated_at DESC`).all(repo) as SpecRow[];
    return rows.map(specRowToRecord);
  }

  /** Picker projection for Board and other in-process consumers. */
  listReadyOptions(workspaceId: string, repo: string): Array<{ readonly id: string; readonly title: string }> {
    return this.db
      .prepare(
        `SELECT id, title FROM specs
         WHERE workspace_id = ? AND repo = ? AND status = 'ready'
         ORDER BY title, id`,
      )
      .all(workspaceId, repo) as Array<{ id: string; title: string }>;
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
  workspace_id: string;
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

interface SpecListRow {
  id: string;
  workspace_id: string;
  repo: string;
  title: string;
  status: SpecRecord['status'];
  source: SpecRecord['source'];
  storage: SpecRecord['storage'];
  path: string | null;
  generate_run_id: string | null;
  drift_note: string | null;
  content_length: number;
  created_at: number;
  updated_at: number;
}

function specRowToRecord(row: SpecRow): SpecRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
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

function specListRowToRecord(row: SpecListRow): SpecListRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    repo: row.repo,
    title: row.title,
    status: row.status,
    source: row.source,
    storage: row.storage,
    path: row.path,
    generateRunId: row.generate_run_id,
    driftNote: row.drift_note,
    contentLength: row.content_length,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
