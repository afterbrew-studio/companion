import { defineMigrations } from '@companion/core/server';

/**
 * v1 = idempotent adopt of today's live plan-domain shape: proposals and their
 * analyze/implement lifecycle, specs (+ drift notes), workspace docs and the
 * FTS5 chunk index behind retrieval. Running it against an existing DB is a
 * no-op (`IF NOT EXISTS` + try/catch ALTER); against a fresh DB it produces
 * the current schema.
 */
export default defineMigrations([
  {
    version: 1,
    name: 'plan_init',
    up: (db, env) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS proposals (
          id               TEXT PRIMARY KEY,
          repo             TEXT NOT NULL,
          title            TEXT NOT NULL,
          body             TEXT NOT NULL,
          status           TEXT NOT NULL,
          analysis         TEXT,
          analysis_run_id  TEXT,
          implement_run_id TEXT,
          branch           TEXT,
          pr_url           TEXT,
          created_at       INTEGER NOT NULL,
          updated_at       INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS specs (
          id              TEXT PRIMARY KEY,
          repo            TEXT NOT NULL,
          title           TEXT NOT NULL,
          content         TEXT NOT NULL DEFAULT '',
          status          TEXT NOT NULL,
          source          TEXT NOT NULL,
          storage         TEXT NOT NULL DEFAULT 'virtual',
          path            TEXT,
          generate_run_id TEXT,
          drift_note      TEXT,
          created_at      INTEGER NOT NULL,
          updated_at      INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_specs_repo ON specs(repo);

        CREATE TABLE IF NOT EXISTS docs (
          id           TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          repo         TEXT,
          title        TEXT NOT NULL,
          content      TEXT NOT NULL DEFAULT '',
          source       TEXT NOT NULL,
          storage      TEXT NOT NULL DEFAULT 'virtual',
          path         TEXT,
          embedder     TEXT NOT NULL DEFAULT 'local-bm25',
          chunk_count  INTEGER NOT NULL DEFAULT 0,
          created_at   INTEGER NOT NULL,
          updated_at   INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_docs_workspace ON docs(workspace_id);
      `);
      // Additive columns on pre-existing tables (CREATE TABLE IF NOT EXISTS won't add them).
      for (const ddl of [
        `ALTER TABLE specs ADD COLUMN storage TEXT NOT NULL DEFAULT 'virtual'`,
        `ALTER TABLE specs ADD COLUMN path TEXT`,
        `ALTER TABLE specs ADD COLUMN drift_note TEXT`,
        `ALTER TABLE docs ADD COLUMN storage TEXT NOT NULL DEFAULT 'virtual'`,
        `ALTER TABLE docs ADD COLUMN path TEXT`,
      ]) {
        try {
          db.exec(ddl);
        } catch {
          // column already exists
        }
      }
      // Chunk index for the built-in local-bm25 embedder. FTS5 ships in the
      // bundled SQLite; if a custom build lacks it, docs still work — search
      // falls back to a LIKE scan over full documents.
      if (env.fts.available) {
        db.exec(
          `CREATE VIRTUAL TABLE IF NOT EXISTS doc_chunks
           USING fts5(content, doc_id UNINDEXED, workspace_id UNINDEXED, seq UNINDEXED)`,
        );
      }
    },
    down: (db) => {
      // Dropping a virtual table needs its FTS5 module loaded — guard it so a
      // build without FTS5 (where the table never existed) still rolls back.
      try {
        db.exec(`DROP TABLE IF EXISTS doc_chunks`);
      } catch {
        // doc_chunks absent (FTS5 unavailable)
      }
      db.exec(`DROP TABLE IF EXISTS docs; DROP TABLE IF EXISTS specs; DROP TABLE IF EXISTS proposals;`);
    },
  },
]);
