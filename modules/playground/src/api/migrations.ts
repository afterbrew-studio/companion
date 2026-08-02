import { defineMigrations } from '@moxxy/companion-sdk/server';

export default defineMigrations([
  {
    version: 1,
    name: 'playground_evaluation_cases',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS playground_evaluation_cases (
          id              TEXT PRIMARY KEY,
          name            TEXT NOT NULL,
          description     TEXT NOT NULL DEFAULT '',
          prompt          TEXT NOT NULL,
          repo            TEXT,
          workspace_id    TEXT,
          owner_id        TEXT NOT NULL,
          skill           TEXT,
          timeout_ms      INTEGER NOT NULL,
          tags            TEXT NOT NULL DEFAULT '[]',
          safety_critical INTEGER NOT NULL DEFAULT 0,
          expectation     TEXT NOT NULL,
          revision        INTEGER NOT NULL DEFAULT 1,
          created_at      INTEGER NOT NULL,
          updated_at      INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_playground_cases_workspace
          ON playground_evaluation_cases(workspace_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_playground_cases_owner
          ON playground_evaluation_cases(owner_id, updated_at DESC);

        CREATE TABLE IF NOT EXISTS playground_evaluation_runs (
          id              TEXT PRIMARY KEY,
          case_id         TEXT NOT NULL,
          case_name       TEXT NOT NULL,
          case_revision   INTEGER NOT NULL,
          prompt_version  INTEGER NOT NULL,
          case_snapshot   TEXT NOT NULL,
          run_id          TEXT,
          status          TEXT NOT NULL,
          checks          TEXT NOT NULL DEFAULT '[]',
          message         TEXT,
          error           TEXT,
          duration_ms     INTEGER NOT NULL,
          input_tokens    INTEGER,
          output_tokens   INTEGER,
          model           TEXT,
          created_at      INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_playground_runs_case
          ON playground_evaluation_runs(case_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_playground_runs_created
          ON playground_evaluation_runs(created_at DESC);
      `);
    },
    down: (db) => {
      db.exec(`
        DROP TABLE IF EXISTS playground_evaluation_runs;
        DROP TABLE IF EXISTS playground_evaluation_cases;
      `);
    },
  },
  {
    version: 2,
    name: 'playground_production_evaluation_runs',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS playground_production_evaluation_runs (
          id                    TEXT PRIMARY KEY,
          case_id               TEXT NOT NULL,
          case_name             TEXT NOT NULL,
          case_revision         INTEGER NOT NULL,
          adapter_id            TEXT NOT NULL,
          adapter_version       INTEGER NOT NULL,
          prompt_fingerprint    TEXT NOT NULL,
          run_id                TEXT,
          status                TEXT NOT NULL,
          checks                TEXT NOT NULL DEFAULT '[]',
          parsed_output         TEXT,
          message               TEXT,
          error                 TEXT,
          duration_ms           INTEGER NOT NULL,
          input_tokens          INTEGER,
          output_tokens         INTEGER,
          model                 TEXT,
          configuration         TEXT NOT NULL,
          owner_id              TEXT NOT NULL,
          created_at            INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_playground_production_runs_owner
          ON playground_production_evaluation_runs(owner_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_playground_production_runs_case
          ON playground_production_evaluation_runs(owner_id, case_id, created_at DESC);
      `);
    },
    down: (db) => {
      db.exec(`DROP TABLE IF EXISTS playground_production_evaluation_runs`);
    },
  },
  {
    version: 3,
    name: 'playground_production_evaluation_suites',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS playground_production_evaluation_suites (
          id                TEXT PRIMARY KEY,
          owner_id          TEXT NOT NULL,
          status            TEXT NOT NULL,
          total             INTEGER NOT NULL,
          completed         INTEGER NOT NULL DEFAULT 0,
          current_case_id   TEXT,
          current_case_name TEXT,
          case_ids          TEXT NOT NULL,
          error             TEXT,
          created_at        INTEGER NOT NULL,
          updated_at        INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_playground_production_suites_owner
          ON playground_production_evaluation_suites(owner_id, created_at DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_playground_production_suites_live
          ON playground_production_evaluation_suites(owner_id)
          WHERE status = 'running';
      `);
    },
    down: (db) => {
      db.exec(`DROP TABLE IF EXISTS playground_production_evaluation_suites`);
    },
  },
  {
    version: 4,
    name: 'playground_production_suite_budget',
    up: (db) => {
      const columns = db
        .prepare(`PRAGMA table_info(playground_production_evaluation_suites)`)
        .all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'budget')) {
        db.exec(`
          ALTER TABLE playground_production_evaluation_suites
          ADD COLUMN budget TEXT NOT NULL DEFAULT '{"startedAt":0,"deadlineAt":0,"maxTokens":1000000,"inputTokens":0,"outputTokens":0,"reportedRuns":0,"missingRuns":0,"estimatedCostUsd":0,"costPartial":false}'
        `);
      }
    },
    down: () => {
      // Additive production columns are intentionally retained on downgrade.
    },
  },
]);
