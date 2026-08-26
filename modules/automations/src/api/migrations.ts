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
  {
    version: 2,
    name: 'durable_webhook_work_and_contributor_flows',
    up: (db) => {
      const deliveryColumns = db.prepare(`PRAGMA table_info(automation_deliveries)`).all() as Array<{ name: string }>;
      const add = (name: string, ddl: string): void => {
        if (!deliveryColumns.some((column) => column.name === name)) db.exec(ddl);
      };
      add('action', `ALTER TABLE automation_deliveries ADD COLUMN action TEXT NOT NULL DEFAULT ''`);
      add('payload', `ALTER TABLE automation_deliveries ADD COLUMN payload TEXT NOT NULL DEFAULT '{}'`);
      add('stage', `ALTER TABLE automation_deliveries ADD COLUMN stage TEXT NOT NULL DEFAULT 'accepted'`);
      add('attempts', `ALTER TABLE automation_deliveries ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`);
      add('next_attempt_at', `ALTER TABLE automation_deliveries ADD COLUMN next_attempt_at INTEGER`);
      add('last_error', `ALTER TABLE automation_deliveries ADD COLUMN last_error TEXT`);
      add('started_at', `ALTER TABLE automation_deliveries ADD COLUMN started_at INTEGER`);

      // Pre-v2 processing rows cannot be replayed: their payload was never
      // retained. Surface that fact once rather than pretending they completed.
      db.exec(`
        UPDATE automation_deliveries
        SET status = 'failed', stage = 'legacy delivery cannot be replayed',
            last_error = 'received before durable webhook payloads were enabled'
        WHERE status = 'processing' AND payload = '{}';

        CREATE INDEX IF NOT EXISTS idx_automation_deliveries_due
          ON automation_deliveries(status, next_attempt_at, received_at);

        CREATE TABLE IF NOT EXISTS contributor_flows (
          repo                   TEXT PRIMARY KEY,
          workspace_id           TEXT NOT NULL,
          mode                    TEXT NOT NULL,
          actionable_issue_kinds  TEXT NOT NULL DEFAULT '["bug","docs","chore"]',
          queue_issues            INTEGER NOT NULL DEFAULT 1,
          auto_apply_triage       INTEGER NOT NULL DEFAULT 1,
          merge_method            TEXT NOT NULL DEFAULT 'squash',
          max_attempts            INTEGER NOT NULL DEFAULT 3,
          owner_id                TEXT NOT NULL,
          updated_at              INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_contributor_flows_workspace
          ON contributor_flows(workspace_id, repo);
      `);
    },
    down: (db) => {
      db.exec(`
        DROP INDEX IF EXISTS idx_contributor_flows_workspace;
        DROP TABLE IF EXISTS contributor_flows;
        DROP INDEX IF EXISTS idx_automation_deliveries_due;
      `);
      // Delivery columns are additive evidence. Rebuilding the ledger only to
      // remove them would discard jobs during a rollback.
    },
  },
  {
    version: 3,
    name: 'ordered_webhook_subject_lanes',
    up: (db) => {
      const columns = db.prepare(`PRAGMA table_info(automation_deliveries)`).all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'ordering_key')) {
        db.exec(`ALTER TABLE automation_deliveries ADD COLUMN ordering_key TEXT NOT NULL DEFAULT ''`);
      }
      // Legacy queued work remains conservative (one lane per repository).
      // New work uses issue/PR/SHA lanes, so a huge review cannot block every
      // unrelated contribution in the same high-volume repository.
      db.exec(`
        UPDATE automation_deliveries SET ordering_key = repo WHERE ordering_key = '';
        CREATE INDEX IF NOT EXISTS idx_automation_deliveries_subject_order
          ON automation_deliveries(ordering_key, status, received_at, id)
      `);
    },
    down: (db) => {
      db.exec(`DROP INDEX IF EXISTS idx_automation_deliveries_subject_order`);
      // Additive ordering evidence is safe for an older build to ignore.
    },
  },
  {
    version: 4,
    name: 'delivery_health_and_retention_index',
    up: (db) => {
      // Health is queried by the workspaces a viewer may access. Without this
      // shape, every Automations refresh scans the whole retained webhook log.
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_automation_deliveries_repo_status_received
          ON automation_deliveries(repo, status, received_at DESC)
      `);
    },
    down: (db) => {
      db.exec(`DROP INDEX IF EXISTS idx_automation_deliveries_repo_status_received`);
    },
  },
  {
    version: 5,
    name: 'repository_automation_admission_control',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS automation_admission_controls (
          repo       TEXT PRIMARY KEY,
          reason     TEXT NOT NULL,
          paused_by  TEXT NOT NULL,
          paused_at  INTEGER NOT NULL
        )
      `);
    },
    down: (db) => {
      db.exec(`DROP TABLE IF EXISTS automation_admission_controls`);
    },
  },
  {
    version: 6,
    name: 'contributor_flow_admission_label',
    up: (db) => {
      // Nullable, and null means "as before": a flow that predates this column
      // keeps admitting on the triage verdict alone. Defaulting it to a label
      // would silently stop every existing flow at the next restart.
      db.exec(`ALTER TABLE contributor_flows ADD COLUMN admit_label TEXT`);
    },
    down: (db) => {
      db.exec(`ALTER TABLE contributor_flows DROP COLUMN admit_label`);
    },
  },
]);
