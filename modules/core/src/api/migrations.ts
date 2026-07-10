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
]);
