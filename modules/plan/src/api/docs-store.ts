import type Database from 'better-sqlite3';
import { likeArg } from '@moxxy-ai/companion-sdk/server';
import type { DocRecord, DocSearchHit } from '../contract/index.js';

/** Workspace docs plus their BM25 chunk index for retrieval. */
export class DocsStore {
  constructor(
    private readonly db: Database.Database,
    /** FTS5 available in this SQLite build (set during migrate). */
    private readonly ftsReady: boolean,
  ) {}

  insert(d: DocRecord): void {
    this.db
      .prepare(
        `INSERT INTO docs (id, workspace_id, repo, title, content, source, storage, path, embedder, chunk_count, created_at, updated_at)
         VALUES (@id, @workspaceId, @repo, @title, @content, @source, @storage, @path, @embedder, @chunkCount, @createdAt, @updatedAt)`,
      )
      .run({ ...d });
  }

  update(
    id: string,
    fields: Partial<{
      title: string;
      content: string;
      repo: string | null;
      storage: DocRecord['storage'];
      path: string | null;
      chunkCount: number;
    }>,
  ): void {
    const current = this.get(id);
    if (!current) return;
    const next = { ...current, ...fields, updatedAt: Date.now() };
    this.db
      .prepare(
        `UPDATE docs SET title = @title, content = @content, repo = @repo, storage = @storage,
         path = @path, chunk_count = @chunkCount, updated_at = @updatedAt WHERE id = @id`,
      )
      .run({
        id,
        title: next.title,
        content: next.content,
        repo: next.repo,
        storage: next.storage,
        path: next.path,
        chunkCount: next.chunkCount,
        updatedAt: next.updatedAt,
      });
  }

  get(id: string): DocRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM docs WHERE id = ?`).get(id) as DocRow | undefined;
    return row ? docRowToRecord(row) : undefined;
  }

  remove(id: string): void {
    this.db.prepare(`DELETE FROM docs WHERE id = ?`).run(id);
    if (this.ftsReady) this.db.prepare(`DELETE FROM doc_chunks WHERE doc_id = ?`).run(id);
  }

  listWorkspace(workspaceId: string): DocRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM docs WHERE workspace_id = ? ORDER BY updated_at DESC`)
      .all(workspaceId) as DocRow[];
    return rows.map(docRowToRecord);
  }

  /** Replace a doc's indexed chunks (the local-bm25 embedder's write path). */
  setChunks(docId: string, workspaceId: string, chunks: readonly string[]): number {
    if (!this.ftsReady) {
      this.update(docId, { chunkCount: 0 });
      return 0;
    }
    const insert = this.db.prepare(
      `INSERT INTO doc_chunks (content, doc_id, workspace_id, seq) VALUES (?, ?, ?, ?)`,
    );
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM doc_chunks WHERE doc_id = ?`).run(docId);
      chunks.forEach((content, seq) => insert.run(content, docId, workspaceId, seq));
    })();
    this.update(docId, { chunkCount: chunks.length });
    return chunks.length;
  }

  /**
   * Retrieval over the workspace's indexed chunks, best match first. BM25 via
   * FTS5 when available; LIKE scan over whole documents otherwise.
   */
  searchChunks(workspaceId: string, query: string, limit = 8): DocSearchHit[] {
    const tokens = query.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) ?? [];
    if (tokens.length === 0) return [];
    if (!this.ftsReady) {
      const rows = this.db
        .prepare(
          `SELECT * FROM docs WHERE workspace_id = ? AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')
           ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(workspaceId, likeArg(query), likeArg(query), limit) as DocRow[];
      return rows.map((row) => ({
        docId: row.id,
        title: row.title,
        repo: row.repo,
        seq: 0,
        content: row.content.slice(0, 700),
        score: 0,
      }));
    }
    // Quote each token so user input can never inject FTS5 query syntax.
    const match = tokens.map((t) => `"${t.replaceAll('"', '')}"`).join(' OR ');
    const rows = this.db
      .prepare(
        `SELECT c.doc_id AS docId, c.seq AS seq, c.content AS content, bm25(doc_chunks) AS rank,
                d.title AS title, d.repo AS repo
         FROM doc_chunks c JOIN docs d ON d.id = c.doc_id
         WHERE doc_chunks MATCH ? AND c.workspace_id = ?
         ORDER BY rank LIMIT ?`,
      )
      .all(match, workspaceId, limit) as Array<{
      docId: string;
      seq: number;
      content: string;
      rank: number;
      title: string;
      repo: string | null;
    }>;
    // bm25() is smaller-is-better (negative); negate so higher is better.
    return rows.map((row) => ({
      docId: row.docId,
      title: row.title,
      repo: row.repo,
      seq: Number(row.seq),
      content: row.content,
      score: -row.rank,
    }));
  }
}

interface DocRow {
  id: string;
  workspace_id: string;
  repo: string | null;
  title: string;
  content: string;
  source: DocRecord['source'];
  storage: DocRecord['storage'];
  path: string | null;
  embedder: string;
  chunk_count: number;
  created_at: number;
  updated_at: number;
}

function docRowToRecord(row: DocRow): DocRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    repo: row.repo,
    title: row.title,
    content: row.content,
    source: row.source,
    storage: row.storage,
    path: row.path,
    embedder: row.embedder,
    chunkCount: row.chunk_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
