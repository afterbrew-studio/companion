import type { Database, Logger } from '@moxxy/companion-services';

export interface MigrationEnv {
  readonly moduleId: string;
  readonly log: Logger;
  /** Whether SQLite FTS5 is available (probed once at bootstrap). */
  readonly fts: { readonly available: boolean };
}

export interface Migration {
  readonly version: number;
  readonly name: string;
  up(db: Database, env: MigrationEnv): void;
  /** Absent ⇒ irreversible; uninstall must use the module's `purge()`. */
  down?(db: Database, env: MigrationEnv): void;
}

const BOOTSTRAP = `
  CREATE TABLE IF NOT EXISTS modules (
    id           TEXT PRIMARY KEY,
    installed    INTEGER NOT NULL DEFAULT 1,
    enabled      INTEGER NOT NULL DEFAULT 1,
    version      INTEGER NOT NULL DEFAULT 0,
    required     INTEGER NOT NULL DEFAULT 0,
    installed_at INTEGER NOT NULL DEFAULT 0,
    updated_at   INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS module_migrations (
    module_id  TEXT NOT NULL,
    version    INTEGER NOT NULL,
    name       TEXT NOT NULL,
    applied_at INTEGER NOT NULL,
    PRIMARY KEY (module_id, version)
  );
  CREATE TABLE IF NOT EXISTS module_config (
    module_id  TEXT NOT NULL,
    key        TEXT NOT NULL,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (module_id, key)
  );
`;

/**
 * Additive reconcile for the bootstrap `modules` table: a DB created by an
 * earlier build may lack a column added later (the kernel tables have no
 * versioned migration of their own — `CREATE TABLE IF NOT EXISTS` won't alter an
 * existing table). Each ALTER is idempotent — a "duplicate column" throw means
 * it's already there — mirroring the per-module v1 adopt. Every column carries a
 * DEFAULT so the ADD succeeds against a populated table; the reconcile INSERT in
 * the kernel then fills real values.
 */
const MODULE_COLUMNS: readonly string[] = [
  `ALTER TABLE modules ADD COLUMN installed INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE modules ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE modules ADD COLUMN version INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE modules ADD COLUMN required INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE modules ADD COLUMN installed_at INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE modules ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0`,
];

function reconcileBootstrap(db: Database): void {
  for (const ddl of MODULE_COLUMNS) {
    try {
      db.exec(ddl);
    } catch (err) {
      if (!String(err).includes('duplicate column')) throw err;
    }
  }
}

/**
 * Per-module migration ledger with rollback. `migrateUp` applies pending steps
 * in a transaction and records them; `migrateDown` walks `down()` in reverse
 * (or throws for an irreversible chain → the module must `purge()`). Owns the
 * kernel bootstrap tables and the one-time FTS5 probe.
 */
export class MigrationRunner {
  readonly fts: { available: boolean };

  constructor(
    private readonly db: Database,
    private readonly log: Logger,
  ) {
    db.exec(BOOTSTRAP);
    reconcileBootstrap(db);
    this.fts = { available: probeFts(db) };
  }

  appliedVersion(moduleId: string): number {
    const row = this.db
      .prepare(`SELECT MAX(version) AS v FROM module_migrations WHERE module_id = ?`)
      .get(moduleId) as { v: number | null } | undefined;
    return row?.v ?? 0;
  }

  private env(moduleId: string): MigrationEnv {
    return { moduleId, log: this.log, fts: this.fts };
  }

  migrateUp(moduleId: string, migrations: readonly Migration[]): void {
    const current = this.appliedVersion(moduleId);
    this.guardSchemaAhead(moduleId, current, migrations);
    const pending = migrations.filter((m) => m.version > current).sort((a, b) => a.version - b.version);
    const env = this.env(moduleId);
    for (const m of pending) {
      this.db.transaction(() => {
        m.up(this.db, env);
        this.db
          .prepare(`INSERT INTO module_migrations (module_id, version, name, applied_at) VALUES (?,?,?,?)`)
          .run(moduleId, m.version, m.name, Date.now());
      })();
    }
  }

  /**
   * A ledger newer than the binary means the daemon was downgraded under a
   * database some later build already migrated. This build cannot know what
   * those migrations changed, so serving the data anyway risks silent
   * corruption; refuse boot unless the operator explicitly accepts the risk.
   */
  private guardSchemaAhead(moduleId: string, applied: number, migrations: readonly Migration[]): void {
    const known = migrations.reduce((max, m) => Math.max(max, m.version), 0);
    if (applied <= known) return;
    const message =
      `module '${moduleId}' has schema version v${applied} applied, but this binary only knows migrations up to v${known}. ` +
      `The database was written by a newer Companion. Upgrade the binary back to that version, ` +
      `or restore the pre-upgrade backup (companion restore <snapshot>) to match this one.`;
    if (process.env.COMPANION_ALLOW_SCHEMA_AHEAD === '1') {
      this.log.warn(`COMPANION_ALLOW_SCHEMA_AHEAD=1: booting on a schema from the future. ${message}`);
      return;
    }
    throw new Error(`${message} Set COMPANION_ALLOW_SCHEMA_AHEAD=1 to boot anyway, at the risk of data corruption.`);
  }

  migrateDown(moduleId: string, migrations: readonly Migration[], to = 0): void {
    const current = this.appliedVersion(moduleId);
    const undo = migrations
      .filter((m) => m.version > to && m.version <= current)
      .sort((a, b) => b.version - a.version);
    const env = this.env(moduleId);
    for (const m of undo) {
      if (!m.down) {
        throw new Error(`migration ${moduleId} v${m.version} (${m.name}) is irreversible; use purge()`);
      }
      const down = m.down;
      this.db.transaction(() => {
        down(this.db, env);
        this.db.prepare(`DELETE FROM module_migrations WHERE module_id = ? AND version = ?`).run(moduleId, m.version);
      })();
    }
  }

  /** Forget a module's applied-migration history — so a re-enable after uninstall
   *  re-runs its migrations from scratch (the purge path drops tables without
   *  unrecording, and even the clean down path is belt-and-braced here). */
  clearLedger(moduleId: string): void {
    this.db.prepare(`DELETE FROM module_migrations WHERE module_id = ?`).run(moduleId);
  }

  /** Mark v1 applied WITHOUT executing — the adopt path for an existing DB whose
   *  tables already match today's shape. */
  adopt(moduleId: string, version: number, name: string): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO module_migrations (module_id, version, name, applied_at) VALUES (?,?,?,?)`)
      .run(moduleId, version, name, Date.now());
  }
}

function probeFts(db: Database): boolean {
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS __fts_probe USING fts5(x)`);
    db.exec(`DROP TABLE IF EXISTS __fts_probe`);
    return true;
  } catch {
    return false;
  }
}
