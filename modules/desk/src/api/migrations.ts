import { defineMigrations } from '@moxxy/companion-sdk/server';

export default defineMigrations([
  {
    version: 1,
    name: 'durable_desk_missions',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS desk_missions (
          id            TEXT PRIMARY KEY,
          owner_id      TEXT NOT NULL,
          title         TEXT NOT NULL,
          workspace_id  TEXT NOT NULL,
          repo          TEXT,
          runner_id     TEXT,
          contexts      TEXT NOT NULL DEFAULT '[]',
          run_id        TEXT UNIQUE,
          archived      INTEGER NOT NULL DEFAULT 0,
          created_at    INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_desk_missions_owner_active
          ON desk_missions(owner_id, archived, updated_at DESC, id DESC);
      `);
    },
    down: (db) => {
      db.exec(`
        DROP INDEX IF EXISTS idx_desk_missions_owner_active;
        DROP TABLE IF EXISTS desk_missions;
      `);
    },
  },
  {
    version: 2,
    name: 'capture_mission_runtime',
    up: (db) => {
      db.exec(`ALTER TABLE desk_missions ADD COLUMN harness TEXT;`);
    },
    // Version 1 drops the owning table during uninstall. Shipped migrations
    // stay additive; removing a column would require a table rewrite.
    down: () => undefined,
  },
]);
