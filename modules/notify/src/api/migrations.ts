import { defineMigrations } from '@moxxy/companion-sdk/server';

export default defineMigrations([
  {
    version: 1,
    name: 'notify_init',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS notify_deliveries (
          id              TEXT PRIMARY KEY,
          connection_id   TEXT NOT NULL,
          provider_id     TEXT NOT NULL,
          connection_name TEXT NOT NULL,
          scope_key       TEXT NOT NULL,
          owner_id        TEXT,
          title           TEXT NOT NULL,
          status          TEXT NOT NULL,
          http_status     INTEGER,
          error           TEXT,
          attempts        INTEGER NOT NULL DEFAULT 1,
          created_at      INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_notify_deliveries_at ON notify_deliveries(created_at);
        CREATE INDEX IF NOT EXISTS idx_notify_deliveries_visibility
          ON notify_deliveries(scope_key, owner_id, created_at DESC);
      `);
    },
    down: (db) => {
      db.exec(`DROP TABLE IF EXISTS notify_deliveries`);
    },
  },
]);
