import { defineMigrations } from '@moxxy/companion-sdk/server';

/**
 * Provider records, and only their non-secret half.
 *
 * The credential itself is NOT here: it stays in the kernel's `SecretStore`
 * under `provider:<id>:key`, which is the same split module-code already uses
 * for hidden pipeline variables. An instance that moved its secrets to Vault
 * keeps these there too, and the read API can answer "is it configured" without
 * ever reading the value.
 */
export default defineMigrations([
  {
    version: 1,
    name: 'model_providers_init',
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS model_providers (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        kind TEXT NOT NULL,
        base_url TEXT,
        headers TEXT NOT NULL DEFAULT '{}',
        query TEXT NOT NULL DEFAULT '{}',
        api_version TEXT,
        factory_options TEXT NOT NULL DEFAULT '{}',
        models TEXT NOT NULL DEFAULT '[]',
        workspace_ids TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_model_providers_enabled ON model_providers(enabled)`);
    },
    down: (db) => {
      db.exec(`DROP TABLE IF EXISTS model_providers`);
    },
  },
  {
    version: 2,
    name: 'mcp_servers_init',
    up: (db) => {
      // Same split as providers: everything but the credential, which stays in
      // the kernel's `SecretStore` under `mcp:<id>:secret`.
      db.exec(`CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        transport TEXT NOT NULL,
        command TEXT,
        args TEXT NOT NULL DEFAULT '[]',
        env TEXT NOT NULL DEFAULT '{}',
        url TEXT,
        headers TEXT NOT NULL DEFAULT '{}',
        access TEXT NOT NULL DEFAULT '[]',
        tools TEXT,
        workspace_ids TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled ON mcp_servers(enabled)`);
    },
    down: (db) => {
      db.exec(`DROP TABLE IF EXISTS mcp_servers`);
    },
  },
]);
