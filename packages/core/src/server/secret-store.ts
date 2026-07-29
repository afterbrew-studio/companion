import type { Database } from '@moxxy/companion-services';
import type { SecretStore } from './capabilities.js';

/**
 * The default `SecretStore`: the same `module_config` table the rest of the
 * config lives in, so a stock instance needs no extra service and an existing
 * install needs no migration. Rows are routed here by key, not by table, which
 * is why this needs the same `isSecret` predicate the config store uses.
 *
 * The value is stored JSON-encoded, matching every other row in the table.
 */
export class SqliteSecretStore implements SecretStore {
  constructor(
    private readonly db: Database,
    private readonly isSecret: (moduleId: string, key: string) => boolean,
  ) {}

  get(moduleId: string, key: string): string | null {
    const row = this.db
      .prepare(`SELECT value FROM module_config WHERE module_id = ? AND key = ?`)
      .get(moduleId, key) as { value: string } | undefined;
    if (!row) return null;
    try {
      const v: unknown = JSON.parse(row.value);
      return typeof v === 'string' ? v : String(v);
    } catch {
      return null;
    }
  }

  set(moduleId: string, key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO module_config (module_id, key, value, updated_at) VALUES (?,?,?,?)
         ON CONFLICT(module_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(moduleId, key, JSON.stringify(value), Date.now());
  }

  delete(moduleId: string, key: string): void {
    this.db.prepare(`DELETE FROM module_config WHERE module_id = ? AND key = ?`).run(moduleId, key);
  }

  keys(moduleId: string): readonly string[] {
    const rows = this.db.prepare(`SELECT key FROM module_config WHERE module_id = ?`).all(moduleId) as {
      key: string;
    }[];
    return rows.map((r) => r.key).filter((k) => this.isSecret(moduleId, k));
  }

  deleteAll(moduleId: string): void {
    for (const key of this.keys(moduleId)) this.delete(moduleId, key);
  }
}
