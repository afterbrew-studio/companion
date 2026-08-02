import { defineMigrations } from '@moxxy/companion-sdk/server';

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
  {
    version: 3,
    name: 'notification_repo_scope',
    up: (db) => {
      try {
        db.exec(`ALTER TABLE notifications ADD COLUMN repo TEXT`);
      } catch {
        // column already exists
      }
    },
    down: () => undefined,
  },
  {
    /**
     * Whom a notification concerns. NULL keeps today's meaning: everyone who can
     * see the workspace. A value narrows it to one person, which is what lets an
     * outbound channel be personal instead of a firehose of everybody's work.
     */
    version: 4,
    name: 'notifications_recipient',
    up: (db) => {
      try {
        db.exec(`ALTER TABLE notifications ADD COLUMN user_id TEXT`);
      } catch (err) {
        if (!/duplicate column name/i.test(String(err))) throw err;
      }
    },
    down: (db) => {
      try {
        db.exec(`ALTER TABLE notifications DROP COLUMN user_id`);
      } catch {
        // Older SQLite cannot drop a column; it is nullable, so leaving it is inert.
      }
    },
  },
  {
    version: 5,
    name: 'notification_read_receipts',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS notification_reads (
          notification_id TEXT NOT NULL,
          username        TEXT NOT NULL,
          read_at         INTEGER NOT NULL,
          PRIMARY KEY (notification_id, username)
        );
        CREATE INDEX IF NOT EXISTS idx_notification_reads_user
          ON notification_reads(username, read_at DESC);
      `);
      // Targeted legacy rows can be attributed safely. A shared legacy read
      // remains in notifications.read_at as a compatibility fallback because
      // there is no honest way to infer who acknowledged it.
      db.exec(`
        INSERT OR IGNORE INTO notification_reads (notification_id, username, read_at)
        SELECT id, user_id, read_at FROM notifications
        WHERE user_id IS NOT NULL AND read_at IS NOT NULL;
      `);
    },
    down: (db) => {
      db.exec(`DROP TABLE IF EXISTS notification_reads`);
    },
  },
  {
    version: 6,
    name: 'notification_feed_indexes',
    up: (db) => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_notifications_feed
          ON notifications(created_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_notifications_workspace_feed
          ON notifications(workspace_id, created_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_notifications_user_feed
          ON notifications(user_id, created_at DESC, id DESC);
      `);
    },
    down: (db) => {
      db.exec(`
        DROP INDEX IF EXISTS idx_notifications_user_feed;
        DROP INDEX IF EXISTS idx_notifications_workspace_feed;
        DROP INDEX IF EXISTS idx_notifications_feed;
      `);
    },
  },
]);
