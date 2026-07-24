import { defineMigrations } from '@companion/core/server';

export default defineMigrations([
  {
    version: 1,
    name: 'planner_sessions',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS planner_sessions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          repo TEXT NOT NULL,
          branch TEXT NOT NULL,
          author TEXT NOT NULL,
          title TEXT NOT NULL,
          idea TEXT NOT NULL,
          step TEXT NOT NULL,
          status TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 0,
          active_action TEXT,
          last_error TEXT,
          brief_json TEXT NOT NULL,
          questions_json TEXT NOT NULL DEFAULT '[]',
          answers_json TEXT NOT NULL DEFAULT '[]',
          messages_json TEXT NOT NULL DEFAULT '[]',
          artifacts_json TEXT,
          pending_revision_json TEXT,
          confirmations_json TEXT NOT NULL,
          doc_id TEXT,
          spec_id TEXT,
          proposal_id TEXT,
          analysis_json TEXT,
          analysis_run_id TEXT,
          refinement_id TEXT,
          task_ids_json TEXT NOT NULL DEFAULT '[]',
          active_queue_id TEXT,
          active_run_id TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_planner_sessions_workspace
          ON planner_sessions(workspace_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_planner_sessions_author_status
          ON planner_sessions(author, status);
        CREATE TABLE IF NOT EXISTS planner_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          detail_json TEXT NOT NULL DEFAULT '{}',
          created_at INTEGER NOT NULL,
          FOREIGN KEY(session_id) REFERENCES planner_sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_planner_events_session
          ON planner_events(session_id, id DESC);
      `);
    },
    down: (db) => {
      db.exec(`
        DROP TABLE IF EXISTS planner_events;
        DROP TABLE IF EXISTS planner_sessions;
      `);
    },
  },
]);
