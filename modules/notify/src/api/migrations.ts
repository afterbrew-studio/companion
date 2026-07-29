import { defineMigrations } from '@moxxy/companion-sdk/server';

export default defineMigrations([
  {
    version: 1,
    name: 'notify_init',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS notify_channels (
          id           TEXT PRIMARY KEY,
          workspace_id TEXT,
          kind         TEXT NOT NULL,
          name         TEXT NOT NULL,
          url          TEXT NOT NULL,
          secret       TEXT,
          kinds        TEXT NOT NULL DEFAULT '[]',
          enabled      INTEGER NOT NULL DEFAULT 1,
          last_status  TEXT,
          last_error   TEXT,
          last_attempt_at INTEGER,
          created_at   INTEGER NOT NULL,
          updated_at   INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_notify_channels_ws ON notify_channels(workspace_id);
        CREATE TABLE IF NOT EXISTS notify_deliveries (
          id           TEXT PRIMARY KEY,
          channel_id   TEXT NOT NULL,
          channel_name TEXT NOT NULL,
          title        TEXT NOT NULL,
          status       TEXT NOT NULL,
          http_status  INTEGER,
          error        TEXT,
          attempts     INTEGER NOT NULL DEFAULT 1,
          created_at   INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_notify_deliveries_at ON notify_deliveries(created_at);
      `);
    },
    down: (db) => {
      db.exec(`
        DROP TABLE IF EXISTS notify_deliveries;
        DROP TABLE IF EXISTS notify_channels;
      `);
    },
  },
]);
