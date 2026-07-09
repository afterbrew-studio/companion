import type Database from 'better-sqlite3';

/** Schema DDL: idempotent CREATEs plus additive ALTERs for pre-existing installs. */
export function migrate(db: Database.Database): { ftsReady: boolean } {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id            TEXT PRIMARY KEY,
      kind          TEXT NOT NULL,
      status        TEXT NOT NULL,
      title         TEXT NOT NULL,
      cwd           TEXT NOT NULL,
      repo          TEXT,
      issue_number  INTEGER,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      input_tokens  INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      outcome       TEXT,
      user_id       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS repos (
      full_name      TEXT PRIMARY KEY,
      owner          TEXT NOT NULL,
      name           TEXT NOT NULL,
      default_branch TEXT NOT NULL DEFAULT 'main',
      private        INTEGER NOT NULL DEFAULT 0,
      clone_ready    INTEGER NOT NULL DEFAULT 0,
      last_sync_at   INTEGER,
      auto_triage    INTEGER NOT NULL DEFAULT 0,
      digest_enabled INTEGER NOT NULL DEFAULT 0,
      stale_enabled  INTEGER NOT NULL DEFAULT 0,
      webhook_secret TEXT
    );

    CREATE TABLE IF NOT EXISTS issues (
      repo       TEXT NOT NULL,
      number     INTEGER NOT NULL,
      title      TEXT NOT NULL,
      body       TEXT NOT NULL DEFAULT '',
      state      TEXT NOT NULL,
      labels     TEXT NOT NULL DEFAULT '[]',
      author     TEXT NOT NULL DEFAULT '',
      assignees  TEXT NOT NULL DEFAULT '[]',
      comments   INTEGER NOT NULL DEFAULT 0,
      url        TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (repo, number)
    );
    CREATE INDEX IF NOT EXISTS idx_issues_state ON issues(repo, state);

    CREATE TABLE IF NOT EXISTS prs (
      repo       TEXT NOT NULL,
      number     INTEGER NOT NULL,
      title      TEXT NOT NULL,
      state      TEXT NOT NULL,
      head_ref   TEXT NOT NULL DEFAULT '',
      author     TEXT NOT NULL DEFAULT '',
      url        TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (repo, number)
    );

    CREATE TABLE IF NOT EXISTS triage_results (
      id           TEXT PRIMARY KEY,
      repo         TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      run_id       TEXT NOT NULL,
      status       TEXT NOT NULL,
      verdict      TEXT,
      error        TEXT,
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_triage_issue ON triage_results(repo, issue_number);

    CREATE TABLE IF NOT EXISTS proposals (
      id               TEXT PRIMARY KEY,
      repo             TEXT NOT NULL,
      title            TEXT NOT NULL,
      body             TEXT NOT NULL,
      status           TEXT NOT NULL,
      analysis         TEXT,
      analysis_run_id  TEXT,
      implement_run_id TEXT,
      branch           TEXT,
      pr_url           TEXT,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reports (
      id         TEXT PRIMARY KEY,
      repo       TEXT,
      kind       TEXT NOT NULL,
      title      TEXT NOT NULL,
      body       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      username   TEXT NOT NULL,
      role       TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      username      TEXT PRIMARY KEY,
      email         TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL,
      disabled      INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      slug        TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      visibility  TEXT NOT NULL DEFAULT 'public',
      owner_id    TEXT,
      created_at  INTEGER NOT NULL
    );

    -- Members of a private workspace (owner + invitees). Public workspaces
    -- carry no rows here; access is universal.
    CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_id TEXT NOT NULL,
      username     TEXT NOT NULL,
      role         TEXT NOT NULL DEFAULT 'member',
      created_at   INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, username)
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(username);

    CREATE TABLE IF NOT EXISTS pipelines (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name         TEXT NOT NULL,
      description  TEXT NOT NULL DEFAULT '',
      steps        TEXT NOT NULL DEFAULT '[]',
      auto_run     INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS step_definitions (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name         TEXT NOT NULL,
      description  TEXT NOT NULL DEFAULT '',
      step         TEXT NOT NULL,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pipeline_runs (
      id            TEXT PRIMARY KEY,
      pipeline_id   TEXT NOT NULL,
      pipeline_name TEXT NOT NULL,
      repo          TEXT NOT NULL,
      pr_number     INTEGER NOT NULL,
      status        TEXT NOT NULL,
      trigger       TEXT NOT NULL,
      steps         TEXT NOT NULL DEFAULT '[]',
      created_at    INTEGER NOT NULL,
      finished_at   INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_pipeline_runs_pr ON pipeline_runs(repo, pr_number);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS pr_reviews (
      id         TEXT PRIMARY KEY,
      repo       TEXT NOT NULL,
      pr_number  INTEGER NOT NULL,
      run_id     TEXT NOT NULL,
      status     TEXT NOT NULL,
      verdict    TEXT,
      error      TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pr_reviews ON pr_reviews(repo, pr_number);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS github_accounts (
      id         TEXT PRIMARY KEY,
      login      TEXT NOT NULL,
      token      TEXT NOT NULL,
      purposes   TEXT NOT NULL DEFAULT '[]',
      scope      TEXT NOT NULL DEFAULT 'shared',
      owner_id   TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS github_account_workspaces (
      account_id   TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      PRIMARY KEY (account_id, workspace_id)
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT,
      kind         TEXT NOT NULL,
      title        TEXT NOT NULL,
      body         TEXT NOT NULL DEFAULT '',
      href         TEXT,
      read_at      INTEGER,
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_queue (
      id           TEXT PRIMARY KEY,
      position     INTEGER NOT NULL,
      kind         TEXT NOT NULL,
      title        TEXT NOT NULL,
      repo         TEXT,
      issue_number INTEGER,
      priority     INTEGER NOT NULL,
      resume_type  TEXT NOT NULL,
      resume_args  TEXT NOT NULL DEFAULT '{}',
      enqueued_at  INTEGER NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS specs (
      id              TEXT PRIMARY KEY,
      repo            TEXT NOT NULL,
      title           TEXT NOT NULL,
      content         TEXT NOT NULL DEFAULT '',
      status          TEXT NOT NULL,
      source          TEXT NOT NULL,
      storage         TEXT NOT NULL DEFAULT 'virtual',
      path            TEXT,
      generate_run_id TEXT,
      drift_note      TEXT,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_specs_repo ON specs(repo);

    CREATE TABLE IF NOT EXISTS docs (
      id           TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      repo         TEXT,
      title        TEXT NOT NULL,
      content      TEXT NOT NULL DEFAULT '',
      source       TEXT NOT NULL,
      storage      TEXT NOT NULL DEFAULT 'virtual',
      path         TEXT,
      embedder     TEXT NOT NULL DEFAULT 'local-bm25',
      chunk_count  INTEGER NOT NULL DEFAULT 0,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_docs_workspace ON docs(workspace_id);

    CREATE TABLE IF NOT EXISTS runners (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      kind          TEXT NOT NULL,
      endpoint      TEXT,
      token         TEXT,
      scope         TEXT NOT NULL DEFAULT 'shared',
      max_runs      INTEGER NOT NULL DEFAULT 3,
      enabled       INTEGER NOT NULL DEFAULT 1,
      model_pins    TEXT NOT NULL DEFAULT '{}',
      catalog       TEXT,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS runner_workspaces (
      runner_id    TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      PRIMARY KEY (runner_id, workspace_id)
    );
  `);
  // Chunk index for the built-in local-bm25 embedder. FTS5 ships in the
  // bundled SQLite; if a custom build lacks it, docs still work — search
  // falls back to a LIKE scan over full documents.
  let ftsReady = false;
  try {
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS doc_chunks
       USING fts5(content, doc_id UNINDEXED, workspace_id UNINDEXED, seq UNINDEXED)`,
    );
    ftsReady = true;
  } catch {
    ftsReady = false;
  }
  // Additive columns on pre-existing tables (CREATE TABLE IF NOT EXISTS won't add them).
  for (const ddl of [
    `ALTER TABLE runs ADD COLUMN proposal_id TEXT`,
    `ALTER TABLE runs ADD COLUMN branch TEXT`,
    `ALTER TABLE runs ADD COLUMN pr_url TEXT`,
    `ALTER TABLE runs ADD COLUMN model TEXT`,
    `ALTER TABLE prs ADD COLUMN body TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE prs ADD COLUMN base_ref TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE prs ADD COLUMN draft INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE prs ADD COLUMN head_sha TEXT`,
    `ALTER TABLE prs ADD COLUMN checks TEXT`,
    `ALTER TABLE prs ADD COLUMN closed_at INTEGER`,
    `ALTER TABLE issues ADD COLUMN closed_at INTEGER`,
    `ALTER TABLE repos ADD COLUMN pr_gate INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE repos ADD COLUMN workspace_id TEXT`,
    `ALTER TABLE repos ADD COLUMN github_account_id TEXT`,
    `ALTER TABLE prs ADD COLUMN labels TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE prs ADD COLUMN assignees TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE prs ADD COLUMN comments INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE prs ADD COLUMN review_decision TEXT`,
    `ALTER TABLE pipelines ADD COLUMN type TEXT NOT NULL DEFAULT 'pr'`,
    `ALTER TABLE pipeline_runs ADD COLUMN target TEXT NOT NULL DEFAULT 'pr'`,
    `ALTER TABLE reports ADD COLUMN issue_number INTEGER`,
    `ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE specs ADD COLUMN storage TEXT NOT NULL DEFAULT 'virtual'`,
    `ALTER TABLE specs ADD COLUMN path TEXT`,
    `ALTER TABLE docs ADD COLUMN storage TEXT NOT NULL DEFAULT 'virtual'`,
    `ALTER TABLE docs ADD COLUMN path TEXT`,
    `ALTER TABLE specs ADD COLUMN drift_note TEXT`,
    `ALTER TABLE repos ADD COLUMN auto_merge INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE runs ADD COLUMN runner_id TEXT`,
    `ALTER TABLE repos ADD COLUMN runner_id TEXT`,
    `ALTER TABLE github_accounts ADD COLUMN scope TEXT NOT NULL DEFAULT 'shared'`,
    `ALTER TABLE workspaces ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'`,
    `ALTER TABLE workspaces ADD COLUMN owner_id TEXT`,
    `ALTER TABLE runners ADD COLUMN model_pins TEXT NOT NULL DEFAULT '{}'`,
    `ALTER TABLE runners ADD COLUMN catalog TEXT`,
    `ALTER TABLE runs ADD COLUMN user_id TEXT`,
    `ALTER TABLE github_accounts ADD COLUMN owner_id TEXT`,
  ]) {
    try {
      db.exec(ddl);
    } catch {
      // column already exists
    }
  }
  // Backfill ownership of existing AI Help runs from the per-user run map, so
  // they become private to their owner immediately (not visible to everyone).
  try {
    db.exec(`
      UPDATE runs SET user_id = (
        SELECT substr(s.key, length('assistant:run:') + 1)
        FROM settings s WHERE s.value = runs.id AND s.key LIKE 'assistant:run:%'
      )
      WHERE kind = 'assistant' AND user_id IS NULL
        AND EXISTS (SELECT 1 FROM settings s WHERE s.value = runs.id AND s.key LIKE 'assistant:run:%')
    `);
  } catch {
    // best-effort backfill
  }
  return { ftsReady };
}
