import { defineMigrations } from '@moxxy/companion-sdk/server';

export default defineMigrations([
  {
    version: 1,
    name: 'github_delivery_idempotency',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS automation_deliveries (
          id           TEXT PRIMARY KEY,
          repo         TEXT NOT NULL,
          event        TEXT NOT NULL,
          status       TEXT NOT NULL,
          received_at  INTEGER NOT NULL,
          completed_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_automation_deliveries_received
          ON automation_deliveries(received_at);
      `);
    },
    down: (db) => {
      db.exec(`DROP TABLE IF EXISTS automation_deliveries`);
    },
  },
]);
