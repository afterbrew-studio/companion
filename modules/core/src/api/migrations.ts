import { defineMigrations } from '@companion/core/server';

/**
 * v1 = idempotent adopt of today's live shape (users/sessions/settings). Running
 * it against an existing DB is a no-op (`IF NOT EXISTS` + try/catch ALTER);
 * against a fresh DB it produces the current schema. `down` drops the tables
 * (uninstall) — but module-core is required and cannot be disabled/uninstalled.
 */
export default defineMigrations([
  {
    version: 1,
    name: 'core_init',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          username      TEXT PRIMARY KEY,
          email         TEXT NOT NULL DEFAULT '',
          password_hash TEXT NOT NULL,
          role          TEXT NOT NULL,
          disabled      INTEGER NOT NULL DEFAULT 0,
          created_at    INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY,
          username   TEXT NOT NULL,
          role       TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
      for (const ddl of [`ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT ''`]) {
        try {
          db.exec(ddl);
        } catch {
          // column already exists
        }
      }
    },
    down: (db) => {
      db.exec(`DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS users; DROP TABLE IF EXISTS settings;`);
    },
  },
  {
    version: 2,
    name: 'custom_roles',
    // Roles become instance data. The three built-ins are seeded so an existing
    // install is unchanged: with no override rows the fold reproduces exactly
    // the module-granted grid it had before.
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS roles (
          id          TEXT PRIMARY KEY,
          title       TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          builtin     INTEGER NOT NULL DEFAULT 0,
          created_at  INTEGER NOT NULL
        );
        -- Append-only. Only RBAC changes land here for now, so it stays tiny;
        -- the audit module (game plan P6.2) owns retention and export when it
        -- takes over this table.
        CREATE TABLE IF NOT EXISTS audit_log (
          id     INTEGER PRIMARY KEY AUTOINCREMENT,
          at     INTEGER NOT NULL,
          actor  TEXT NOT NULL,
          action TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log (at);
        CREATE TABLE IF NOT EXISTS role_permissions (
          role_id    TEXT NOT NULL,
          permission TEXT NOT NULL,
          mode       TEXT NOT NULL CHECK (mode IN ('grant', 'revoke')),
          created_at INTEGER NOT NULL,
          PRIMARY KEY (role_id, permission)
        );
      `);
      const now = Date.now();
      const seed = db.prepare(
        `INSERT INTO roles (id, title, description, builtin, created_at) VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(id) DO NOTHING`,
      );
      seed.run('admin', 'Administrator', 'Full control of the instance.', now);
      seed.run('maintainer', 'Maintainer', 'Runs the day-to-day engineering work.', now);
      seed.run('business', 'Business', 'Read-mostly access for non-engineering stakeholders.', now);
    },
    down: (db) => {
      db.exec(`DROP TABLE IF EXISTS audit_log; DROP TABLE IF EXISTS role_permissions; DROP TABLE IF EXISTS roles;`);
    },
  },
  {
    version: 3,
    name: 'audit_route_columns',
    // v2's audit_log only described RBAC edits. The router now records every
    // mutating request, which needs the route, the permission it demanded and
    // the status the caller got, so an auditor can answer "who changed what,
    // and was it allowed" without joining anything.
    up: (db) => {
      for (const ddl of [
        `ALTER TABLE audit_log ADD COLUMN access TEXT NOT NULL DEFAULT ''`,
        `ALTER TABLE audit_log ADD COLUMN status INTEGER NOT NULL DEFAULT 0`,
        `ALTER TABLE audit_log ADD COLUMN module TEXT`,
        `ALTER TABLE audit_log ADD COLUMN detail TEXT`,
      ]) {
        try {
          db.exec(ddl);
        } catch {
          // column already exists
        }
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log (actor, at)`);
    },
    down: (db) => {
      // SQLite cannot drop a column on older builds and the data is the point;
      // dropping the index is the only reversible half.
      db.exec(`DROP INDEX IF EXISTS idx_audit_actor`);
    },
  },
]);
