import { defineMigrations } from '@companion/core/server';

/** v1 = idempotent adopt of today's workspaces + membership tables. */
export default defineMigrations([
  {
    version: 1,
    name: 'workspace_init',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS workspaces (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          slug        TEXT NOT NULL UNIQUE,
          description TEXT NOT NULL DEFAULT '',
          visibility  TEXT NOT NULL DEFAULT 'public',
          owner_id    TEXT,
          created_at  INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS workspace_members (
          workspace_id TEXT NOT NULL,
          username     TEXT NOT NULL,
          role         TEXT NOT NULL DEFAULT 'member',
          created_at   INTEGER NOT NULL,
          PRIMARY KEY (workspace_id, username)
        );
        CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(username);
        CREATE TABLE IF NOT EXISTS notifications (
          id           TEXT PRIMARY KEY,
          workspace_id TEXT,
          kind         TEXT NOT NULL,
          title        TEXT NOT NULL,
          body         TEXT NOT NULL DEFAULT '',
          href         TEXT,
          read_at      INTEGER,
          created_at   INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at);
        CREATE TABLE IF NOT EXISTS reports (
          id           TEXT PRIMARY KEY,
          workspace_id TEXT,
          repo         TEXT,
          kind         TEXT NOT NULL,
          title        TEXT NOT NULL,
          body         TEXT NOT NULL,
          created_at   INTEGER NOT NULL
        );
      `);
      for (const ddl of [
        `ALTER TABLE workspaces ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'`,
        `ALTER TABLE workspaces ADD COLUMN owner_id TEXT`,
        `ALTER TABLE reports ADD COLUMN issue_number INTEGER`,
      ]) {
        try {
          db.exec(ddl);
        } catch {
          // column already exists
        }
      }
    },
    down: (db) => {
      db.exec(
        `DROP TABLE IF EXISTS reports; DROP TABLE IF EXISTS notifications; DROP TABLE IF EXISTS workspace_members; DROP TABLE IF EXISTS workspaces;`,
      );
    },
  },
  {
    version: 2,
    name: 'report_workspace_scope',
    up: (db) => {
      try {
        db.exec(`ALTER TABLE reports ADD COLUMN workspace_id TEXT`);
      } catch {
        // column already exists
      }
    },
    down: () => undefined,
  },
]);
