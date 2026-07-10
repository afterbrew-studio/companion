import { defineMigrations } from '@companion/core/server';

/**
 * v1 = idempotent adopt of today's live execution-plane shape: runs + the
 * durable run queue + runners (and their workspace delegation side table).
 * Running it against an existing DB is a no-op (`IF NOT EXISTS` + try/catch
 * ALTER); against a fresh DB it produces the current schema.
 */
export default defineMigrations([
  {
    version: 1,
    name: 'operate_init',
    up: (db) => {
      db.exec(`
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
          outcome       TEXT,
          user_id       TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

        CREATE TABLE IF NOT EXISTS run_queue (
          id           TEXT PRIMARY KEY,
          position     INTEGER NOT NULL,
          kind         TEXT NOT NULL,
          title        TEXT NOT NULL,
          repo         TEXT,
          issue_number INTEGER,
          priority     INTEGER NOT NULL,
          resume_type  TEXT NOT NULL,
          resume_args  TEXT NOT NULL DEFAULT '{}',
          enqueued_at  INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS runners (
          id            TEXT PRIMARY KEY,
          name          TEXT NOT NULL,
          kind          TEXT NOT NULL,
          endpoint      TEXT,
          token         TEXT,
          scope         TEXT NOT NULL DEFAULT 'shared',
          max_runs      INTEGER NOT NULL DEFAULT 3,
          enabled       INTEGER NOT NULL DEFAULT 1,
          model_pins    TEXT NOT NULL DEFAULT '{}',
          catalog       TEXT,
          created_at    INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS runner_workspaces (
          runner_id    TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          PRIMARY KEY (runner_id, workspace_id)
        );
      `);
      // Additive columns on pre-existing tables (CREATE TABLE IF NOT EXISTS won't add them).
      for (const ddl of [
        `ALTER TABLE runs ADD COLUMN proposal_id TEXT`,
        `ALTER TABLE runs ADD COLUMN branch TEXT`,
        `ALTER TABLE runs ADD COLUMN pr_url TEXT`,
        `ALTER TABLE runs ADD COLUMN model TEXT`,
        `ALTER TABLE runs ADD COLUMN runner_id TEXT`,
        `ALTER TABLE runs ADD COLUMN user_id TEXT`,
        `ALTER TABLE runners ADD COLUMN model_pins TEXT NOT NULL DEFAULT '{}'`,
        `ALTER TABLE runners ADD COLUMN catalog TEXT`,
      ]) {
        try {
          db.exec(ddl);
        } catch {
          // column already exists
        }
      }
      // Backfill ownership of existing AI Help runs from the per-user run map, so
      // they become private to their owner immediately (not visible to everyone).
      try {
        db.exec(`
          UPDATE runs SET user_id = (
            SELECT substr(s.key, length('assistant:run:') + 1)
            FROM settings s WHERE s.value = runs.id AND s.key LIKE 'assistant:run:%'
          )
          WHERE kind = 'assistant' AND user_id IS NULL
            AND EXISTS (SELECT 1 FROM settings s WHERE s.value = runs.id AND s.key LIKE 'assistant:run:%')
        `);
      } catch {
        // best-effort backfill
      }
    },
    down: (db) => {
      db.exec(
        `DROP TABLE IF EXISTS runner_workspaces; DROP TABLE IF EXISTS runners; DROP TABLE IF EXISTS run_queue; DROP TABLE IF EXISTS runs;`,
      );
    },
  },
]);
