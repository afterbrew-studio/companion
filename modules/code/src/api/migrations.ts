import { defineMigrations } from '@moxxy/companion-sdk/server';

/**
 * v1 = idempotent adopt of today's live code-domain shape: repos + the
 * issues/PRs sync cache, triage + AI review verdicts, the GitHub account
 * registry (and its workspace delegation side table), and pipelines (+ the
 * step library and run history). Running it against an existing DB is a no-op
 * (`IF NOT EXISTS` + try/catch ALTER); against a fresh DB it produces the
 * current schema.
 */
export default defineMigrations([
  {
    version: 1,
    name: 'code_init',
    up: (db) => {
      db.exec(`
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
      // Additive columns on pre-existing tables (CREATE TABLE IF NOT EXISTS won't add them).
      for (const ddl of [
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
        `ALTER TABLE repos ADD COLUMN auto_merge INTEGER NOT NULL DEFAULT 0`,
        `ALTER TABLE repos ADD COLUMN runner_id TEXT`,
        `ALTER TABLE github_accounts ADD COLUMN scope TEXT NOT NULL DEFAULT 'shared'`,
        `ALTER TABLE github_accounts ADD COLUMN owner_id TEXT`,
      ]) {
        try {
          db.exec(ddl);
        } catch {
          // column already exists
        }
      }
      // The owner-published read view: other modules JOIN this to scope by
      // workspace instead of touching the repos table directly.
      db.exec(`CREATE VIEW IF NOT EXISTS v_repos AS SELECT full_name, workspace_id FROM repos`);
    },
    down: (db) => {
      db.exec(
        `DROP VIEW IF EXISTS v_repos;
         DROP TABLE IF EXISTS pipeline_runs; DROP TABLE IF EXISTS step_definitions; DROP TABLE IF EXISTS pipelines;
         DROP TABLE IF EXISTS github_account_workspaces; DROP TABLE IF EXISTS github_accounts;
         DROP TABLE IF EXISTS pr_reviews; DROP TABLE IF EXISTS triage_results;
         DROP TABLE IF EXISTS prs; DROP TABLE IF EXISTS issues; DROP TABLE IF EXISTS repos;`,
      );
    },
  },
  {
    version: 2,
    name: 'code_pr_mergeable',
    up: (db) => {
      db.exec(`ALTER TABLE prs ADD COLUMN mergeable INTEGER`);
    },
    down: (db) => {
      db.exec(`ALTER TABLE prs DROP COLUMN mergeable`);
    },
  },
  {
    version: 3,
    name: 'code_repo_workspaces',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS repo_workspaces (
          repo         TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          created_at   INTEGER NOT NULL,
          PRIMARY KEY (repo, workspace_id)
        );
        CREATE INDEX IF NOT EXISTS idx_repo_workspaces_workspace
          ON repo_workspaces(workspace_id, repo);
        INSERT OR IGNORE INTO repo_workspaces (repo, workspace_id, created_at)
          SELECT full_name, workspace_id, CAST(strftime('%s', 'now') AS INTEGER) * 1000
          FROM repos WHERE workspace_id IS NOT NULL;
        DROP VIEW IF EXISTS v_repos;
        CREATE VIEW v_repos AS
          SELECT repo AS full_name, workspace_id FROM repo_workspaces;
      `);
    },
    down: (db) => {
      db.exec(`
        DROP VIEW IF EXISTS v_repos;
        CREATE VIEW v_repos AS SELECT full_name, workspace_id FROM repos;
        DROP TABLE IF EXISTS repo_workspaces;
      `);
    },
  },
  {
    version: 4,
    name: 'code_personal_webhook_owner',
    up: (db) => {
      for (const ddl of [
        `ALTER TABLE repos ADD COLUMN webhook_owner_id TEXT`,
        `ALTER TABLE repos ADD COLUMN webhook_account_id TEXT`,
        `ALTER TABLE repos ADD COLUMN automation_owner_id TEXT`,
      ]) {
        try {
          db.exec(ddl);
        } catch {
          // column already exists
        }
      }
      db.exec(`
        UPDATE github_accounts SET scope = 'all' WHERE owner_id IS NOT NULL AND scope = 'shared';
        UPDATE github_accounts SET scope = 'selected' WHERE owner_id IS NOT NULL AND scope = 'delegated';
        UPDATE repos SET github_account_id = NULL;
        UPDATE repos
        SET webhook_secret = NULL, webhook_owner_id = NULL, webhook_account_id = NULL
        WHERE webhook_owner_id IS NULL;
      `);
    },
    down: () => undefined,
  },
  {
    version: 5,
    name: 'code_repo_account_bindings',
    up: (db) => {
      // Which of a profile's OWN accounts acts on a repo. Keyed by owner as
      // well as repo: a global pin would let one user's background work borrow
      // another's credential, which is exactly what the personal-account model
      // removed. Absent row = fall back to normal precedence.
      db.exec(`
        CREATE TABLE IF NOT EXISTS repo_account_bindings (
          repo       TEXT NOT NULL,
          owner_id   TEXT NOT NULL,
          account_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (repo, owner_id)
        );
      `);
    },
    down: (db) => {
      db.exec(`DROP TABLE IF EXISTS repo_account_bindings`);
    },
  },
  {
    version: 6,
    name: 'code_github_app_accounts',
    up: (db) => {
      // A GitHub App installation as a credential, alongside personal tokens.
      // Additive on purpose: `token` keeps its meaning for a PAT and becomes the
      // CACHED installation token for an app, with `token_expires_at` saying
      // when it dies. One column means one accessor stays synchronous, and the
      // cache survives a restart instead of re-minting for every account at boot.
      //
      // `private_key` is the app's PEM. It sits here rather than in the secret
      // store because that seam is for per-module CONFIG (one value per key per
      // module), and this is per-row data, exactly like the PAT beside it.
      for (const column of [
        `kind TEXT NOT NULL DEFAULT 'pat'`,
        `app_id TEXT`,
        `installation_id TEXT`,
        `private_key TEXT`,
        `token_expires_at INTEGER`,
      ]) {
        // Idempotent: a re-run on a partially migrated database must not fail.
        try {
          db.exec(`ALTER TABLE github_accounts ADD COLUMN ${column}`);
        } catch (err) {
          if (!/duplicate column name/i.test(String(err))) throw err;
        }
      }
    },
    down: (db) => {
      for (const name of ['kind', 'app_id', 'installation_id', 'private_key', 'token_expires_at']) {
        try {
          db.exec(`ALTER TABLE github_accounts DROP COLUMN ${name}`);
        } catch {
          // Older SQLite cannot drop columns; leaving them is harmless because
          // `kind` defaults to 'pat' and the rest are nullable.
        }
      }
    },
  },
  {
    /**
     * Credential health, so a GitHub App installation that stopped refreshing
     * is visible instead of living on as a dead token until someone reads a log.
     * Persisted rather than held in memory for two reasons: the accounts page
     * can render it, and the "started failing" transition survives a restart, so
     * a daemon that bounces hourly does not re-announce the same outage.
     */
    version: 7,
    name: 'github_credential_health',
    up: (db) => {
      for (const column of ['token_health TEXT', 'token_error TEXT']) {
        try {
          db.exec(`ALTER TABLE github_accounts ADD COLUMN ${column}`);
        } catch (err) {
          if (!/duplicate column name/i.test(String(err))) throw err;
        }
      }
    },
    down: (db) => {
      for (const name of ['token_health', 'token_error']) {
        try {
          db.exec(`ALTER TABLE github_accounts DROP COLUMN ${name}`);
        } catch {
          // Older SQLite cannot drop columns; both are nullable, so a row that
          // keeps them reads exactly as it did before this migration.
        }
      }
    },
  },
  {
    /**
     * The command that proves a diff builds, per repository. Per repo and not
     * instance-wide because it is a property of the project: `pnpm typecheck` in
     * one and `cargo test` in the next. NULL means unset, which is reported as
     * "not checked" rather than as a pass.
     */
    version: 8,
    name: 'repos_verify_command',
    up: (db) => {
      try {
        db.exec(`ALTER TABLE repos ADD COLUMN verify_command TEXT`);
      } catch (err) {
        if (!/duplicate column name/i.test(String(err))) throw err;
      }
    },
    down: (db) => {
      try {
        db.exec(`ALTER TABLE repos DROP COLUMN verify_command`);
      } catch {
        // Older SQLite cannot drop a column; it is nullable, so leaving it is inert.
      }
    },
  },
  {
    /**
     * Why a PR cannot merge, not just whether. `mergeable` alone cannot tell a
     * conflict from a missing required check from a stale branch, and those are
     * three different next actions.
     */
    version: 9,
    name: 'code_pr_merge_state',
    up: (db) => {
      try {
        db.exec(`ALTER TABLE prs ADD COLUMN merge_state TEXT`);
      } catch (err) {
        if (!/duplicate column name/i.test(String(err))) throw err;
      }
    },
    down: (db) => {
      try {
        db.exec(`ALTER TABLE prs DROP COLUMN merge_state`);
      } catch {
        // Older SQLite cannot drop a column; it is nullable, so leaving it is inert.
      }
    },
  },
  {
    /**
     * Ownership for hidden step variables. The VALUE never lands here: it stays
     * in the kernel's SecretStore (swappable to Vault) under `key`. This table
     * holds only who provided it, for which workspace, and whether they meant it
     * to be usable by anyone else.
     *
     * Without this a credential was instance-wide, which on a multi-tenant or
     * cloud deployment pools every user's publish rights into one token.
     */
    version: 10,
    name: 'pipeline_secret_owners',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS pipeline_secrets (
          key TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          owner_id TEXT NOT NULL,
          visibility TEXT NOT NULL DEFAULT 'private',
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_pipeline_secrets_owner ON pipeline_secrets(owner_id);
      `);
    },
    down: (db) => {
      db.exec(`DROP TABLE IF EXISTS pipeline_secrets`);
    },
  },
  {
    /**
     * Findings become rows instead of strings inside the verdict JSON, because
     * each one now carries state a reviewer edits (included/rejected), a
     * verification verdict, and the id of the GitHub comment it became.
     *
     * Anchor columns are nullable on purpose: a finding that could not be tied
     * to a line of the diff is still worth showing, it just travels in the
     * review body rather than as an inline comment.
     */
    version: 11,
    name: 'pr_review_findings',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS pr_review_findings (
          id                TEXT PRIMARY KEY,
          review_id         TEXT NOT NULL,
          source            TEXT NOT NULL DEFAULT 'native',
          file              TEXT,
          side              TEXT,
          line              INTEGER,
          start_line        INTEGER,
          severity          TEXT NOT NULL DEFAULT 'minor',
          title             TEXT NOT NULL,
          reason            TEXT NOT NULL DEFAULT '',
          impact            TEXT NOT NULL DEFAULT '',
          suggestion        TEXT NOT NULL DEFAULT '',
          suggested_patch   TEXT,
          confidence        REAL NOT NULL DEFAULT 0.5,
          state             TEXT NOT NULL DEFAULT 'proposed',
          verification      TEXT NOT NULL DEFAULT 'unverified',
          verification_note TEXT,
          rejection_reason  TEXT,
          github_comment_id INTEGER,
          created_at        INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_prf_review ON pr_review_findings(review_id, state);
      `);
      for (const column of [
        `ALTER TABLE pr_reviews ADD COLUMN head_sha TEXT`,
        `ALTER TABLE pr_reviews ADD COLUMN depth TEXT NOT NULL DEFAULT 'in-depth'`,
        `ALTER TABLE pr_reviews ADD COLUMN strictness TEXT NOT NULL DEFAULT 'balanced'`,
      ]) {
        try {
          db.exec(column);
        } catch (err) {
          if (!/duplicate column name/i.test(String(err))) throw err;
        }
      }
    },
    down: (db) => {
      db.exec(`DROP TABLE IF EXISTS pr_review_findings`);
    },
  },
  {
    /**
     * Answering, in thread, when a pull request author replies to one of the
     * agent's inline comments. Per repository and off by default: unlike every
     * other switch here it makes an agent speak publicly on someone else's pull
     * request, so it is opted into deliberately, never inherited.
     */
    version: 12,
    name: 'repos_review_replies',
    up: (db) => {
      try {
        db.exec(`ALTER TABLE repos ADD COLUMN review_replies INTEGER NOT NULL DEFAULT 0`);
      } catch (err) {
        if (!/duplicate column name/i.test(String(err))) throw err;
      }
    },
    down: (db) => {
      try {
        db.exec(`ALTER TABLE repos DROP COLUMN review_replies`);
      } catch {
        // Older SQLite cannot drop a column; it defaults to 0, so leaving it is inert.
      }
    },
  },
  {
    /**
     * A PR review is an aggregate job: a large change fans out into chunk,
     * verifier, and summary runs. Persist its source, progress, coverage, and
     * every child run so the UI stays truthful across reconnects and restarts.
     */
    version: 13,
    name: 'pr_review_execution_state',
    up: (db) => {
      for (const column of [
        `ALTER TABLE pr_reviews ADD COLUMN source TEXT NOT NULL DEFAULT 'agent'`,
        `ALTER TABLE pr_reviews ADD COLUMN run_ids TEXT NOT NULL DEFAULT '[]'`,
        `ALTER TABLE pr_reviews ADD COLUMN progress TEXT`,
        `ALTER TABLE pr_reviews ADD COLUMN coverage TEXT`,
      ]) {
        try {
          db.exec(column);
        } catch (err) {
          if (!/duplicate column name/i.test(String(err))) throw err;
        }
      }
      // Empty run ids were the legacy marker for a person's own draft.
      db.exec(`UPDATE pr_reviews SET source = 'human' WHERE run_id = '' AND status <> 'failed'`);
      db.exec(`UPDATE pr_reviews SET run_ids = json_array(run_id) WHERE run_id <> ''`);
    },
    down: () => {
      // Additive compatibility columns are inert to an older build. Rebuilding
      // this history table merely to remove them would risk the review record.
    },
  },
  {
    /** Pipeline definitions are editable/deletable; their run history is not. */
    version: 14,
    name: 'pipeline_run_workspace_history',
    up: (db) => {
      try {
        db.exec(`ALTER TABLE pipeline_runs ADD COLUMN workspace_id TEXT`);
      } catch (err) {
        if (!/duplicate column name/i.test(String(err))) throw err;
      }
      db.exec(`
        UPDATE pipeline_runs
           SET workspace_id = (SELECT workspace_id FROM pipelines WHERE pipelines.id = pipeline_runs.pipeline_id)
         WHERE workspace_id IS NULL;
        CREATE INDEX IF NOT EXISTS idx_pipeline_runs_workspace
          ON pipeline_runs(workspace_id, created_at DESC);
      `);
    },
    down: (db) => {
      db.exec(`DROP INDEX IF EXISTS idx_pipeline_runs_workspace`);
    },
  },
  {
    /** Hot paths for paged maintainer queues and latest-review decoration. */
    version: 15,
    name: 'maintainer_queue_indexes',
    up: (db) => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_pr_reviews_latest
          ON pr_reviews(repo, pr_number, created_at DESC, id DESC);
        CREATE INDEX IF NOT EXISTS idx_prs_repo_state_updated
          ON prs(repo, state, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_prs_open_head
          ON prs(repo, head_sha) WHERE state = 'open';
      `);
    },
    down: (db) => {
      db.exec(`
        DROP INDEX IF EXISTS idx_pr_reviews_latest;
        DROP INDEX IF EXISTS idx_prs_repo_state_updated;
        DROP INDEX IF EXISTS idx_prs_open_head;
      `);
    },
  },
  {
    /** Exactly-once admission for webhook-triggered pipeline/head pairs. */
    version: 16,
    name: 'pipeline_run_idempotency',
    up: (db) => {
      try {
        db.exec(`ALTER TABLE pipeline_runs ADD COLUMN idempotency_key TEXT`);
      } catch (err) {
        if (!/duplicate column name/i.test(String(err))) throw err;
      }
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_runs_idempotency
          ON pipeline_runs(idempotency_key) WHERE idempotency_key IS NOT NULL;
      `);
    },
    down: (db) => {
      db.exec(`DROP INDEX IF EXISTS idx_pipeline_runs_idempotency`);
    },
  },
  {
    /** Attribute run control and scope its raw live command stream to its starter. */
    version: 17,
    name: 'pipeline_run_owner',
    up: (db) => {
      try {
        db.exec(`ALTER TABLE pipeline_runs ADD COLUMN owner_id TEXT`);
      } catch (err) {
        if (!/duplicate column name/i.test(String(err))) throw err;
      }
    },
    down: () => {
      // Additive compatibility column; rebuilding run history to remove it is unsafe.
    },
  },
  {
    /** Workspace issue queues order within one repository and state. */
    version: 18,
    name: 'issue_maintainer_queue_index',
    up: (db) => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_issues_repo_state_updated
          ON issues(repo, state, updated_at DESC, number DESC);
      `);
    },
    down: (db) => {
      db.exec(`DROP INDEX IF EXISTS idx_issues_repo_state_updated`);
    },
  },
  {
    /** Latest triage decoration is read for only the visible queue window. */
    version: 19,
    name: 'triage_latest_index',
    up: (db) => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_triage_latest
          ON triage_results(repo, issue_number, created_at DESC, id DESC);
      `);
    },
    down: (db) => {
      db.exec(`DROP INDEX IF EXISTS idx_triage_latest`);
    },
  },
]);
