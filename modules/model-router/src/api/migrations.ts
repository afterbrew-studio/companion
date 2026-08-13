import { defineMigrations } from '@moxxy/companion-sdk/server';

export default defineMigrations([
  {
    version: 1,
    name: 'model_router_policy_and_decisions',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS model_router_policy (
          id         TEXT PRIMARY KEY CHECK (id = 'default'),
          revision   INTEGER NOT NULL,
          enabled    INTEGER NOT NULL,
          profiles   TEXT NOT NULL,
          rules      TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS model_router_decisions (
          id               TEXT PRIMARY KEY,
          run_id           TEXT NOT NULL UNIQUE,
          task             TEXT NOT NULL,
          phase            TEXT NOT NULL,
          work_unit_id     TEXT,
          risk             TEXT,
          policy_revision  INTEGER NOT NULL,
          rule_id          TEXT NOT NULL,
          profile_id       TEXT NOT NULL,
          candidate_models TEXT NOT NULL,
          selected_model   TEXT,
          outcome          TEXT NOT NULL,
          created_at       INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_model_router_decisions_created
          ON model_router_decisions(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_model_router_decisions_work_unit
          ON model_router_decisions(work_unit_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_model_router_decisions_task_phase
          ON model_router_decisions(task, phase, created_at DESC);
      `);
    },
    down: (db) => {
      db.exec(`
        DROP TABLE IF EXISTS model_router_decisions;
        DROP TABLE IF EXISTS model_router_policy;
      `);
    },
  },
]);
