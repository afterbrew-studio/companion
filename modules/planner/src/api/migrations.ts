import { defineMigrations } from '@moxxy/companion-sdk/server';

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
  {
    version: 2,
    name: 'planner_target_branch',
    up: (db) => {
      const columns = db.prepare(`PRAGMA table_info(planner_sessions)`).all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'target_branch')) {
        db.exec(`ALTER TABLE planner_sessions ADD COLUMN target_branch TEXT NOT NULL DEFAULT ''`);
      }
    },
    // Existing sessions may already reference launched Board tasks. Removing
    // their recorded merge target during module lifecycle changes is unsafe.
    down: () => undefined,
  },
  {
    version: 3,
    name: 'planner_repository_context',
    up: (db) => {
      const columns = db.prepare(`PRAGMA table_info(planner_sessions)`).all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'repository_context_json')) {
        db.exec(`ALTER TABLE planner_sessions ADD COLUMN repository_context_json TEXT`);
      }
    },
    // The snapshot is additive session history. SQLite cannot safely remove a
    // column in-place while preserving active planning sessions.
    down: () => undefined,
  },
  {
    version: 4,
    name: 'planner_clarification_state',
    up: (db) => {
      const columns = db.prepare(`PRAGMA table_info(planner_sessions)`).all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === 'clarification_state_json')) {
        db.exec(`ALTER TABLE planner_sessions ADD COLUMN clarification_state_json TEXT`);
      }
      const sessions = db.prepare(`
        SELECT id, questions_json, answers_json
        FROM planner_sessions
        WHERE clarification_state_json IS NULL
      `).all() as Array<{ id: string; questions_json: string; answers_json: string }>;
      const eventsFor = db.prepare(`
        SELECT kind, detail_json
        FROM planner_events
        WHERE session_id = ? AND kind IN ('questions_ready', 'clarification_answered', 'brief_ready')
        ORDER BY id
      `);
      const save = db.prepare(`UPDATE planner_sessions SET clarification_state_json = ? WHERE id = ?`);
      for (const session of sessions) {
        const questions = parseJsonArray(session.questions_json);
        const answers = parseJsonArray(session.answers_json);
        const events = eventsFor.all(session.id) as Array<{ kind: string; detail_json: string }>;
        let roundsCreated = 0;
        let completedRounds = 0;
        let questionSetId: string | null = null;
        for (const event of events) {
          const detail = parseJsonObject(event.detail_json);
          const round = typeof detail.round === 'number' && Number.isInteger(detail.round) ? detail.round : 0;
          if (event.kind === 'questions_ready') {
            roundsCreated = Math.max(roundsCreated, round || roundsCreated + 1);
            questionSetId = typeof detail.questionSetId === 'string' ? detail.questionSetId : questionSetId;
          } else if (event.kind === 'clarification_answered') {
            completedRounds = Math.max(completedRounds, round || completedRounds + 1);
          } else if (event.kind === 'brief_ready') {
            questionSetId = null;
          }
        }
        roundsCreated = Math.max(roundsCreated, completedRounds, questions.length > 0 ? completedRounds + 1 : 0);
        const resolvedDecisionKeys = Array.from(new Set(answers.flatMap((answer) => {
          const record = answer && typeof answer === 'object'
            ? answer as Record<string, unknown>
            : null;
          const key = record && typeof record.decisionKey === 'string'
            ? record.decisionKey
            : null;
          return key ? [key] : [];
        })));
        save.run(JSON.stringify({
          currentRound: questions.length > 0 ? Math.max(1, roundsCreated) : roundsCreated,
          roundsCreated,
          completedRounds,
          answerCount: answers.length,
          questionSetId: questions.length > 0 ? questionSetId : null,
          resolvedDecisionKeys,
          roundLimit: 5,
          answerLimit: 15,
          completionReason: null,
          completionExplanation: null,
          unresolvedDecisions: [],
        }), session.id);
      }
    },
    // Clarification state is additive session history and remains readable by
    // older code, which simply ignores the column.
    down: () => undefined,
  },
  {
    version: 5,
    name: 'planner_usage_totals',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS planner_usage_totals (
          session_id                TEXT PRIMARY KEY,
          total_runs                INTEGER NOT NULL DEFAULT 0,
          total_input_tokens        INTEGER NOT NULL DEFAULT 0,
          total_output_tokens       INTEGER NOT NULL DEFAULT 0,
          repository_scan_runs      INTEGER NOT NULL DEFAULT 0,
          cached_snapshot_runs      INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY(session_id) REFERENCES planner_sessions(id) ON DELETE CASCADE
        );

        INSERT OR IGNORE INTO planner_usage_totals (
          session_id, total_runs, total_input_tokens, total_output_tokens,
          repository_scan_runs, cached_snapshot_runs
        )
        SELECT
          session_id,
          COUNT(*),
          COALESCE(SUM(CAST(json_extract(detail_json, '$.inputTokens') AS INTEGER)), 0),
          COALESCE(SUM(CAST(json_extract(detail_json, '$.outputTokens') AS INTEGER)), 0),
          SUM(CASE WHEN json_extract(detail_json, '$.contextMode') = 'repository_scan' THEN 1 ELSE 0 END),
          SUM(CASE WHEN json_extract(detail_json, '$.contextMode') = 'cached_snapshot' THEN 1 ELSE 0 END)
        FROM planner_events
        WHERE kind = 'planner_run_completed' AND json_valid(detail_json)
        GROUP BY session_id;
      `);
    },
    // Usage totals preserve historical resource accounting after event
    // compaction, so module disable/enable must not remove them.
    down: () => undefined,
  },
]);

function parseJsonArray(value: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
