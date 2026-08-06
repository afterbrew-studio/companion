import { defineMigrations } from '@moxxy/companion-sdk/server';

/** Workbench owns proposals only; every resulting domain mutation stays with its owner. */
export default defineMigrations([
  {
    version: 1,
    name: 'workbench_actions',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS workbench_actions (
          id             TEXT PRIMARY KEY,
          workspace_id   TEXT NOT NULL,
          requested_by   TEXT NOT NULL,
          source         TEXT NOT NULL,
          action         TEXT NOT NULL,
          request        TEXT NOT NULL,
          subject        TEXT NOT NULL,
          target_id      TEXT NOT NULL,
          target_version TEXT,
          title          TEXT NOT NULL,
          summary        TEXT NOT NULL,
          consequence    TEXT NOT NULL,
          impact         TEXT NOT NULL,
          href           TEXT NOT NULL,
          status         TEXT NOT NULL,
          created_at     INTEGER NOT NULL,
          expires_at     INTEGER NOT NULL,
          executed_at    INTEGER,
          error          TEXT,
          result         TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_workbench_actions_owner
          ON workbench_actions (requested_by, status, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_workbench_actions_expiry
          ON workbench_actions (status, expires_at);
      `);
    },
    down: (db) => {
      db.exec(`DROP TABLE IF EXISTS workbench_actions`);
    },
  },
]);
