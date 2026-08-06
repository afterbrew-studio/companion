import { defineMigrations } from '@moxxy/companion-sdk/server';

export default defineMigrations([
  {
    version: 1,
    name: 'integrations_connections_and_routes',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS integration_connections (
          id             TEXT PRIMARY KEY,
          provider_id    TEXT NOT NULL,
          name           TEXT NOT NULL,
          scope_kind     TEXT NOT NULL,
          workspace_id   TEXT,
          repo           TEXT,
          owner_id       TEXT,
          config         TEXT NOT NULL DEFAULT '{}',
          enabled        INTEGER NOT NULL DEFAULT 1,
          health_status  TEXT NOT NULL DEFAULT 'unknown',
          health_message TEXT NOT NULL DEFAULT 'Not checked yet',
          checked_at     INTEGER,
          created_at     INTEGER NOT NULL,
          updated_at     INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_integration_connections_provider
          ON integration_connections(provider_id);
        CREATE INDEX IF NOT EXISTS idx_integration_connections_scope
          ON integration_connections(scope_kind, workspace_id, repo, owner_id, enabled);

        CREATE TABLE IF NOT EXISTS integration_routes (
          capability   TEXT NOT NULL,
          scope_key    TEXT NOT NULL,
          scope_kind   TEXT NOT NULL,
          workspace_id TEXT,
          repo         TEXT,
          targets      TEXT NOT NULL DEFAULT '[]',
          updated_at   INTEGER NOT NULL,
          PRIMARY KEY (capability, scope_key)
        );
      `);
    },
    down: (db) => {
      db.exec(`
        DROP TABLE IF EXISTS integration_routes;
        DROP TABLE IF EXISTS integration_connections;
      `);
    },
  },
]);
