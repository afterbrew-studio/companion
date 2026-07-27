import { defineMigrations } from '@moxxy-ai/companion-sdk/server';

export default defineMigrations([
  {
    version: 1,
    name: 'slop_init',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS slop_detections (
          id TEXT PRIMARY KEY, repo TEXT NOT NULL, pr_number INTEGER NOT NULL,
          pr_title TEXT NOT NULL DEFAULT '', run_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending', verdict TEXT, error TEXT,
          applied_action TEXT, rule_ids TEXT NOT NULL DEFAULT '[]',
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_slop_detections_pr ON slop_detections(repo, pr_number, created_at);
        CREATE TABLE IF NOT EXISTS slop_rules (
          id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '', instructions TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS slop_builtin_toggles (
          workspace_id TEXT NOT NULL, rule_id TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          PRIMARY KEY (workspace_id, rule_id)
        );
      `);
    },
    down: (db) => {
      db.exec(`
        DROP TABLE IF EXISTS slop_builtin_toggles;
        DROP TABLE IF EXISTS slop_rules;
        DROP TABLE IF EXISTS slop_detections;
      `);
    },
  },
]);
