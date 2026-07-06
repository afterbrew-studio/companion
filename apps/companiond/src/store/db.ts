import Database from 'better-sqlite3';
import type {
  ChecksSnapshot,
  IssueRecord,
  NotificationRecord,
  GitHubPurpose,
  PipelineRecord,
  PipelineRunRecord,
  PipelineRunStatus,
  PipelineStep,
  PipelineStepResult,
  PipelineStepSpec,
  PipelineTrigger,
  PrRecord,
  PrReviewResult,
  PrReviewVerdict,
  ProposalAnalysis,
  ProposalRecord,
  ReportRecord,
  RepoRecord,
  Role,
  RunKind,
  RunRecord,
  RunStatus,
  StepDefinitionRecord,
  TriageResult,
  TriageVerdict,
  UserRecord,
  WorkspaceMetrics,
  WorkspaceRecord,
} from '@companion/contract';
import { paths } from '../config.js';

/**
 * Companion's domain store. Rows are the source of truth for run/proposal
 * lifecycle (gateway processes are cattle). Issues/PRs are a sync cache of
 * GitHub — GitHub stays authoritative; we never mutate the cache except from
 * sync or an applied action.
 */
export class Store {
  private readonly db: Database.Database;

  constructor(file = paths.db()) {
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
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
        outcome       TEXT
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
        created_at  INTEGER NOT NULL
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
    this.db.exec(`
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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS github_accounts (
        id         TEXT PRIMARY KEY,
        login      TEXT NOT NULL,
        token      TEXT NOT NULL,
        purposes   TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL
      );
    `);
    this.db.exec(`
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
    ]) {
      try {
        this.db.exec(ddl);
      } catch {
        // column already exists
      }
    }
    this.ensureDefaultWorkspace();
  }

  /** Every install has at least one workspace; orphan repos are adopted into it. */
  private ensureDefaultWorkspace(): void {
    const count = this.db.prepare(`SELECT COUNT(*) AS n FROM workspaces`).get() as { n: number };
    if (count.n === 0) {
      this.db
        .prepare(`INSERT INTO workspaces (id, name, slug, description, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run('ws-default', 'Default', 'default', 'Default workspace', Date.now());
    }
    const first = this.db.prepare(`SELECT id FROM workspaces ORDER BY created_at LIMIT 1`).get() as {
      id: string;
    };
    this.db.prepare(`UPDATE repos SET workspace_id = ? WHERE workspace_id IS NULL`).run(first.id);
  }

  close(): void {
    this.db.close();
  }

  // ---------- settings ---------------------------------------------------------

  getSetting(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  // ---------- sessions ----------------------------------------------------------

  insertSession(s: {
    tokenHash: string;
    username: string;
    role: Role;
    createdAt: number;
    expiresAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO sessions (token_hash, username, role, created_at, expires_at)
         VALUES (@tokenHash, @username, @role, @createdAt, @expiresAt)`,
      )
      .run(s);
  }

  getSession(tokenHash: string): {
    tokenHash: string;
    username: string;
    role: Role;
    expiresAt: number;
  } | null {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE token_hash = ?`).get(tokenHash) as
      | { token_hash: string; username: string; role: Role; expires_at: number }
      | undefined;
    if (!row) return null;
    return { tokenHash: row.token_hash, username: row.username, role: row.role, expiresAt: row.expires_at };
  }

  deleteSession(tokenHash: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(tokenHash);
  }

  pruneExpiredSessions(): void {
    this.db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(Date.now());
  }

  deleteSessionsForUser(username: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE username = ?`).run(username);
  }

  // ---------- users -----------------------------------------------------------------

  countUsers(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM users`).get() as { n: number }).n;
  }

  listUsers(): UserRecord[] {
    const rows = this.db.prepare(`SELECT * FROM users ORDER BY created_at`).all() as UserRow[];
    return rows.map(userRowToRecord);
  }

  /** Paged/filtered user listing so the Users view never loads the world. */
  searchUsers(opts: { q?: string; role?: string; limit?: number; offset?: number }): {
    users: UserRecord[];
    total: number;
  } {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.q) {
      where.push(`(username LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')`);
      const like = likeArg(opts.q);
      args.push(like, like);
    }
    if (opts.role) {
      where.push(`role = ?`);
      args.push(opts.role);
    }
    const cond = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM users ${cond}`).get(...args) as { n: number }
    ).n;
    const rows = this.db
      .prepare(`SELECT * FROM users ${cond} ORDER BY created_at LIMIT ? OFFSET ?`)
      .all(...args, opts.limit ?? -1, opts.offset ?? 0) as UserRow[];
    return { users: rows.map(userRowToRecord), total };
  }

  getUser(username: string): (UserRecord & { passwordHash: string }) | undefined {
    const row = this.db.prepare(`SELECT * FROM users WHERE username = ?`).get(username) as
      | UserRow
      | undefined;
    if (!row) return undefined;
    return { ...userRowToRecord(row), passwordHash: row.password_hash };
  }

  getUserByEmail(email: string): (UserRecord & { passwordHash: string }) | undefined {
    const row = this.db
      .prepare(`SELECT * FROM users WHERE email = ? AND email != '' LIMIT 1`)
      .get(email) as UserRow | undefined;
    if (!row) return undefined;
    return { ...userRowToRecord(row), passwordHash: row.password_hash };
  }

  insertUser(u: { username: string; email: string; passwordHash: string; role: Role }): void {
    this.db
      .prepare(
        `INSERT INTO users (username, email, password_hash, role, disabled, created_at)
         VALUES (@username, @email, @passwordHash, @role, 0, @createdAt)`,
      )
      .run({ ...u, createdAt: Date.now() });
  }

  updateUser(
    username: string,
    fields: { email?: string; passwordHash?: string; role?: Role; disabled?: boolean },
  ): void {
    this.db
      .prepare(
        `UPDATE users SET
           email = COALESCE(@email, email),
           password_hash = COALESCE(@passwordHash, password_hash),
           role = COALESCE(@role, role),
           disabled = COALESCE(@disabled, disabled)
         WHERE username = @username`,
      )
      .run({
        username,
        email: fields.email ?? null,
        passwordHash: fields.passwordHash ?? null,
        role: fields.role ?? null,
        disabled: fields.disabled === undefined ? null : fields.disabled ? 1 : 0,
      });
  }

  deleteUser(username: string): void {
    this.db.prepare(`DELETE FROM users WHERE username = ?`).run(username);
    this.deleteSessionsForUser(username);
  }

  /** Enabled admins — deletion/demotion guards keep this above zero. */
  countActiveAdmins(): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0`)
        .get() as { n: number }
    ).n;
  }

  // ---------- workspaces ----------------------------------------------------------

  listWorkspaces(): WorkspaceRecord[] {
    const rows = this.db
      .prepare(
        `SELECT w.*, (SELECT COUNT(*) FROM repos r WHERE r.workspace_id = w.id) AS repo_count
         FROM workspaces w ORDER BY w.created_at`,
      )
      .all() as WorkspaceRow[];
    return rows.map(workspaceRowToRecord);
  }

  getWorkspace(id: string): WorkspaceRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT w.*, (SELECT COUNT(*) FROM repos r WHERE r.workspace_id = w.id) AS repo_count
         FROM workspaces w WHERE w.id = ?`,
      )
      .get(id) as WorkspaceRow | undefined;
    return row ? workspaceRowToRecord(row) : undefined;
  }

  insertWorkspace(w: { id: string; name: string; slug: string; description: string }): void {
    this.db
      .prepare(
        `INSERT INTO workspaces (id, name, slug, description, created_at)
         VALUES (@id, @name, @slug, @description, @createdAt)`,
      )
      .run({ ...w, createdAt: Date.now() });
  }

  updateWorkspace(id: string, fields: { name?: string; description?: string }): void {
    this.db
      .prepare(
        `UPDATE workspaces SET name = COALESCE(?, name), description = COALESCE(?, description) WHERE id = ?`,
      )
      .run(fields.name ?? null, fields.description ?? null, id);
  }

  deleteWorkspace(id: string): void {
    this.db.prepare(`DELETE FROM pipelines WHERE workspace_id = ?`).run(id);
    this.db.prepare(`DELETE FROM step_definitions WHERE workspace_id = ?`).run(id);
    this.db.prepare(`DELETE FROM workspaces WHERE id = ?`).run(id);
  }

  // ---------- runs ------------------------------------------------------------

  insertRun(run: Omit<RunRecord, 'live'>): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, kind, status, title, cwd, repo, issue_number, proposal_id, branch, pr_url, model, created_at, updated_at, input_tokens, output_tokens, outcome)
         VALUES (@id, @kind, @status, @title, @cwd, @repo, @issueNumber, @proposalId, @branch, @prUrl, @model, @createdAt, @updatedAt, @inputTokens, @outputTokens, @outcome)`,
      )
      .run(run);
  }

  setRunModel(id: string, model: string | null): void {
    this.db.prepare(`UPDATE runs SET model = ?, updated_at = ? WHERE id = ?`).run(model, Date.now(), id);
  }

  updateRunStatus(id: string, status: RunStatus, outcome?: string | null): void {
    this.db
      .prepare(
        `UPDATE runs SET status = ?, outcome = COALESCE(?, outcome), updated_at = ? WHERE id = ?`,
      )
      .run(status, outcome ?? null, Date.now(), id);
  }

  setRunPr(id: string, branch: string | null, prUrl: string | null): void {
    this.db
      .prepare(`UPDATE runs SET branch = COALESCE(?, branch), pr_url = COALESCE(?, pr_url), updated_at = ? WHERE id = ?`)
      .run(branch, prUrl, Date.now(), id);
  }

  addRunUsage(id: string, inputTokens: number, outputTokens: number): void {
    this.db
      .prepare(
        `UPDATE runs SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, updated_at = ? WHERE id = ?`,
      )
      .run(inputTokens, outputTokens, Date.now(), id);
  }

  // ---------- github accounts ---------------------------------------------------

  insertGithubAccount(a: { id: string; login: string; token: string; purposes: readonly string[]; createdAt: number }): void {
    this.db
      .prepare(
        `INSERT INTO github_accounts (id, login, token, purposes, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(a.id, a.login, a.token, JSON.stringify(a.purposes), a.createdAt);
  }

  /** Internal rows including tokens — never returned by the API layer. */
  listGithubAccounts(): GithubAccountRow[] {
    const rows = this.db.prepare(`SELECT * FROM github_accounts ORDER BY created_at`).all() as Array<{
      id: string;
      login: string;
      token: string;
      purposes: string;
      created_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      login: r.login,
      token: r.token,
      purposes: JSON.parse(r.purposes) as GitHubPurpose[],
      createdAt: r.created_at,
    }));
  }

  updateGithubAccount(id: string, fields: { login?: string; token?: string; purposes?: readonly string[] }): void {
    this.db
      .prepare(
        `UPDATE github_accounts SET
           login = COALESCE(?, login),
           token = COALESCE(?, token),
           purposes = COALESCE(?, purposes)
         WHERE id = ?`,
      )
      .run(fields.login ?? null, fields.token ?? null, fields.purposes ? JSON.stringify(fields.purposes) : null, id);
  }

  deleteGithubAccount(id: string): void {
    this.db.prepare(`DELETE FROM github_accounts WHERE id = ?`).run(id);
  }

  // ---------- notifications ---------------------------------------------------

  insertNotification(n: Omit<NotificationRecord, 'readAt'>): void {
    this.db
      .prepare(
        `INSERT INTO notifications (id, workspace_id, kind, title, body, href, created_at)
         VALUES (@id, @workspaceId, @kind, @title, @body, @href, @createdAt)`,
      )
      .run(n);
    // Keep the inbox bounded — anything past 30 days is stale.
    this.db.prepare(`DELETE FROM notifications WHERE created_at < ?`).run(Date.now() - 30 * 24 * 3600_000);
  }

  /** Workspace-scoped rows plus instance-wide (NULL workspace) rows, newest first. */
  listNotifications(workspaceId: string | null | undefined, limit = 100): NotificationRecord[] {
    const rows = workspaceId
      ? this.db
          .prepare(
            `SELECT * FROM notifications WHERE workspace_id = ? OR workspace_id IS NULL
             ORDER BY created_at DESC LIMIT ?`,
          )
          .all(workspaceId, limit)
      : this.db.prepare(`SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?`).all(limit);
    return (rows as NotificationRow[]).map(rowToNotification);
  }

  markNotificationRead(id: string): void {
    this.db.prepare(`UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL`).run(Date.now(), id);
  }

  markAllNotificationsRead(workspaceId: string | null | undefined): void {
    if (workspaceId) {
      this.db
        .prepare(
          `UPDATE notifications SET read_at = ? WHERE read_at IS NULL AND (workspace_id = ? OR workspace_id IS NULL)`,
        )
        .run(Date.now(), workspaceId);
    } else {
      this.db.prepare(`UPDATE notifications SET read_at = ? WHERE read_at IS NULL`).run(Date.now());
    }
  }

  getRun(id: string): RunRow | undefined {
    return this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as RunRow | undefined;
  }

  listRuns(limit = 200): RunRow[] {
    return this.db
      .prepare(`SELECT * FROM runs ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as RunRow[];
  }

  /** Boot-time sweep: any run left live-ish died with the daemon. */
  markInterruptedRuns(): number {
    const result = this.db
      .prepare(
        `UPDATE runs SET status = 'interrupted', updated_at = ? WHERE status IN ('running', 'provisioning', 'queued')`,
      )
      .run(Date.now());
    return result.changes;
  }

  // ---------- repos ------------------------------------------------------------

  upsertRepo(repo: {
    fullName: string;
    owner: string;
    name: string;
    defaultBranch: string;
    private: boolean;
    workspaceId?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO repos (full_name, owner, name, default_branch, private, workspace_id)
         VALUES (@fullName, @owner, @name, @defaultBranch, @isPrivate, @workspaceId)
         ON CONFLICT(full_name) DO UPDATE SET
           default_branch = excluded.default_branch, private = excluded.private,
           workspace_id = COALESCE(excluded.workspace_id, repos.workspace_id)`,
      )
      .run({ ...repo, isPrivate: repo.private ? 1 : 0, workspaceId: repo.workspaceId ?? null });
    // A row inserted without a workspace joins the default one.
    this.ensureDefaultWorkspace();
  }

  setRepoWorkspace(fullName: string, workspaceId: string): void {
    this.db.prepare(`UPDATE repos SET workspace_id = ? WHERE full_name = ?`).run(workspaceId, fullName);
  }

  listReposByWorkspace(workspaceId: string): RepoRow[] {
    return this.db
      .prepare(`SELECT * FROM repos WHERE workspace_id = ? ORDER BY full_name`)
      .all(workspaceId) as RepoRow[];
  }

  setRepoCloneReady(fullName: string, ready: boolean): void {
    this.db.prepare(`UPDATE repos SET clone_ready = ? WHERE full_name = ?`).run(ready ? 1 : 0, fullName);
  }

  setRepoSynced(fullName: string): void {
    this.db.prepare(`UPDATE repos SET last_sync_at = ? WHERE full_name = ?`).run(Date.now(), fullName);
  }

  setRepoAutomation(
    fullName: string,
    field: 'auto_triage' | 'digest_enabled' | 'stale_enabled' | 'pr_gate',
    value: boolean,
  ): void {
    this.db.prepare(`UPDATE repos SET ${field} = ? WHERE full_name = ?`).run(value ? 1 : 0, fullName);
  }

  setRepoWebhookSecret(fullName: string, secret: string): void {
    this.db.prepare(`UPDATE repos SET webhook_secret = ? WHERE full_name = ?`).run(secret, fullName);
  }

  getRepoWebhookSecret(fullName: string): string | null {
    const row = this.db.prepare(`SELECT webhook_secret FROM repos WHERE full_name = ?`).get(fullName) as
      | { webhook_secret: string | null }
      | undefined;
    return row?.webhook_secret ?? null;
  }

  setRepoGithubAccount(fullName: string, accountId: string | null): void {
    this.db.prepare(`UPDATE repos SET github_account_id = ? WHERE full_name = ?`).run(accountId, fullName);
  }

  getRepo(fullName: string): RepoRow | undefined {
    return this.db.prepare(`SELECT * FROM repos WHERE full_name = ?`).get(fullName) as RepoRow | undefined;
  }

  listRepos(): RepoRow[] {
    return this.db.prepare(`SELECT * FROM repos ORDER BY full_name`).all() as RepoRow[];
  }

  removeRepo(fullName: string): void {
    this.db.prepare(`DELETE FROM issues WHERE repo = ?`).run(fullName);
    this.db.prepare(`DELETE FROM prs WHERE repo = ?`).run(fullName);
    this.db.prepare(`DELETE FROM repos WHERE full_name = ?`).run(fullName);
  }

  // ---------- issues / prs -------------------------------------------------------

  upsertIssue(issue: Omit<IssueRecord, 'triage'>): void {
    this.db
      .prepare(
        `INSERT INTO issues (repo, number, title, body, state, labels, author, assignees, comments, url, created_at, updated_at, closed_at)
         VALUES (@repo, @number, @title, @body, @state, @labels, @author, @assignees, @comments, @url, @createdAt, @updatedAt, @closedAt)
         ON CONFLICT(repo, number) DO UPDATE SET
           title = excluded.title, body = excluded.body, state = excluded.state,
           labels = excluded.labels, author = excluded.author, assignees = excluded.assignees,
           comments = excluded.comments, url = excluded.url, updated_at = excluded.updated_at,
           closed_at = excluded.closed_at`,
      )
      .run({
        ...issue,
        labels: JSON.stringify(issue.labels),
        assignees: JSON.stringify(issue.assignees),
      });
  }

  listIssues(repo: string, state?: 'open' | 'closed'): IssueRecord[] {
    const rows = (
      state
        ? this.db.prepare(`SELECT * FROM issues WHERE repo = ? AND state = ? ORDER BY number DESC`).all(repo, state)
        : this.db.prepare(`SELECT * FROM issues WHERE repo = ? ORDER BY number DESC`).all(repo)
    ) as IssueRow[];
    const triage = this.latestTriageByIssue(repo);
    return rows.map((row) => issueRowToRecord(row, triage.get(row.number) ?? null));
  }

  getIssue(repo: string, number: number): IssueRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM issues WHERE repo = ? AND number = ?`).get(repo, number) as
      | IssueRow
      | undefined;
    if (!row) return undefined;
    const triage = this.latestTriage(repo, number);
    return issueRowToRecord(row, triage?.status ?? null);
  }

  /** Issues whose updated_at is older than `days` days (open only). */
  listStaleIssues(repo: string, days: number): IssueRecord[] {
    const cutoff = Date.now() - days * 86_400_000;
    const rows = this.db
      .prepare(`SELECT * FROM issues WHERE repo = ? AND state = 'open' AND updated_at < ? ORDER BY updated_at`)
      .all(repo, cutoff) as IssueRow[];
    return rows.map((row) => issueRowToRecord(row, null));
  }

  listIssuesSince(repo: string, since: number): IssueRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM issues WHERE repo = ? AND created_at >= ? ORDER BY number DESC`)
      .all(repo, since) as IssueRow[];
    return rows.map((row) => issueRowToRecord(row, null));
  }

  upsertPr(pr: Omit<PrRecord, 'review' | 'checks' | 'reviewDecision'>): void {
    this.db
      .prepare(
        `INSERT INTO prs (repo, number, title, body, state, head_ref, head_sha, base_ref, draft, author, labels, assignees, url, created_at, updated_at, closed_at)
         VALUES (@repo, @number, @title, @body, @state, @headRef, @headSha, @baseRef, @isDraft, @author, @labelsJson, @assigneesJson, @url, @createdAt, @updatedAt, @closedAt)
         ON CONFLICT(repo, number) DO UPDATE SET
           title = excluded.title, body = excluded.body, state = excluded.state,
           head_ref = excluded.head_ref, base_ref = excluded.base_ref, draft = excluded.draft,
           author = excluded.author, labels = excluded.labels, assignees = excluded.assignees,
           url = excluded.url, updated_at = excluded.updated_at,
           closed_at = excluded.closed_at,
           checks = CASE WHEN excluded.head_sha IS NOT prs.head_sha THEN NULL ELSE prs.checks END,
           head_sha = excluded.head_sha`,
      )
      .run({
        ...pr,
        isDraft: pr.draft ? 1 : 0,
        labelsJson: JSON.stringify(pr.labels),
        assigneesJson: JSON.stringify(pr.assignees),
      });
  }

  /** Human review decision, harvested alongside the checks snapshot. */
  setPrReviewDecision(repo: string, number: number, decision: 'approved' | 'changes_requested' | null): void {
    this.db.prepare(`UPDATE prs SET review_decision = ? WHERE repo = ? AND number = ?`).run(decision, repo, number);
  }

  /** Conversation comment count, harvested from the issues feed during sync. */
  setPrComments(repo: string, number: number, comments: number): void {
    this.db.prepare(`UPDATE prs SET comments = ? WHERE repo = ? AND number = ?`).run(comments, repo, number);
  }

  /** Cache the latest CI snapshot for a PR (invalidated when head_sha moves). */
  setPrChecks(repo: string, number: number, snapshot: ChecksSnapshot): void {
    this.db
      .prepare(`UPDATE prs SET checks = ? WHERE repo = ? AND number = ?`)
      .run(JSON.stringify(snapshot), repo, number);
  }

  listPrs(repo: string): PrRecord[] {
    const rows = this.db.prepare(`SELECT * FROM prs WHERE repo = ? ORDER BY number DESC`).all(repo) as PrRow[];
    const reviews = this.latestPrReviewByNumber(repo);
    return rows.map((r) => prRowToRecord(r, reviews.get(r.number) ?? null));
  }

  getPr(repo: string, number: number): PrRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM prs WHERE repo = ? AND number = ?`).get(repo, number) as
      | PrRow
      | undefined;
    if (!row) return undefined;
    return prRowToRecord(row, this.latestPrReview(repo, number)?.status ?? null);
  }

  // ---------- workspace-scoped area queries ---------------------------------------

  listWorkspaceIssues(workspaceId: string, state?: 'open' | 'closed'): IssueRecord[] {
    const rows = (
      state
        ? this.db
            .prepare(
              `SELECT i.* FROM issues i JOIN repos r ON r.full_name = i.repo
               WHERE r.workspace_id = ? AND i.state = ? ORDER BY i.updated_at DESC`,
            )
            .all(workspaceId, state)
        : this.db
            .prepare(
              `SELECT i.* FROM issues i JOIN repos r ON r.full_name = i.repo
               WHERE r.workspace_id = ? ORDER BY i.updated_at DESC`,
            )
            .all(workspaceId)
    ) as IssueRow[];
    const triageByRepo = new Map<string, Map<number, TriageResult['status']>>();
    return rows.map((row) => {
      let map = triageByRepo.get(row.repo);
      if (!map) {
        map = this.latestTriageByIssue(row.repo);
        triageByRepo.set(row.repo, map);
      }
      return issueRowToRecord(row, map.get(row.number) ?? null);
    });
  }

  listWorkspacePrs(workspaceId: string): PrRecord[] {
    const rows = this.db
      .prepare(
        `SELECT p.* FROM prs p JOIN repos r ON r.full_name = p.repo
         WHERE r.workspace_id = ? ORDER BY p.updated_at DESC`,
      )
      .all(workspaceId) as PrRow[];
    const reviewsByRepo = new Map<string, Map<number, PrReviewResult['status']>>();
    return rows.map((row) => {
      let map = reviewsByRepo.get(row.repo);
      if (!map) {
        map = this.latestPrReviewByNumber(row.repo);
        reviewsByRepo.set(row.repo, map);
      }
      return prRowToRecord(row, map.get(row.number) ?? null);
    });
  }

  /** Paged/filtered issues with per-state counts (for tab chips). */
  listWorkspaceIssuesPaged(
    workspaceId: string,
    state: 'open' | 'closed' | undefined,
    opts: {
      q?: string;
      repo?: string;
      author?: string;
      assignee?: string;
      label?: string;
      limit?: number;
      offset?: number;
    },
  ): {
    issues: IssueRecord[];
    total: number;
    counts: { open: number; closed: number };
    facets: { authors: string[]; assignees: string[]; labels: string[] };
  } {
    const where: string[] = ['r.workspace_id = ?'];
    const args: unknown[] = [workspaceId];
    if (opts.repo) {
      where.push('i.repo = ?');
      args.push(opts.repo);
    }
    if (opts.author) {
      where.push('i.author = ?');
      args.push(opts.author);
    }
    if (opts.assignee === '__none') {
      where.push(`i.assignees = '[]'`);
    } else if (opts.assignee) {
      where.push(`EXISTS (SELECT 1 FROM json_each(i.assignees) WHERE json_each.value = ?)`);
      args.push(opts.assignee);
    }
    if (opts.label) {
      where.push(`EXISTS (SELECT 1 FROM json_each(i.labels) WHERE json_each.value = ?)`);
      args.push(opts.label);
    }
    if (opts.q) {
      where.push(`(i.title LIKE ? ESCAPE '\\' OR i.labels LIKE ? ESCAPE '\\' OR CAST(i.number AS TEXT) = ?)`);
      const like = likeArg(opts.q);
      args.push(like, like, opts.q.replace(/^#/, ''));
    }
    const base = `FROM issues i JOIN repos r ON r.full_name = i.repo WHERE ${where.join(' AND ')}`;
    const counts = { open: 0, closed: 0 };
    for (const row of this.db.prepare(`SELECT i.state AS state, COUNT(*) AS n ${base} GROUP BY i.state`).all(...args) as Array<{ state: string; n: number }>) {
      if (row.state === 'open' || row.state === 'closed') counts[row.state] = row.n;
    }
    const stateCond = state ? ` AND i.state = ?` : '';
    const stateArgs = state ? [...args, state] : args;
    const rows = this.db
      .prepare(`SELECT i.* ${base}${stateCond} ORDER BY i.updated_at DESC LIMIT ? OFFSET ?`)
      .all(...stateArgs, opts.limit ?? -1, opts.offset ?? 0) as IssueRow[];
    const triageByRepo = new Map<string, Map<number, TriageResult['status']>>();
    const issues = rows.map((row) => {
      let map = triageByRepo.get(row.repo);
      if (!map) {
        map = this.latestTriageByIssue(row.repo);
        triageByRepo.set(row.repo, map);
      }
      return issueRowToRecord(row, map.get(row.number) ?? null);
    });
    const total = state ? counts[state] : counts.open + counts.closed;
    const facetBase = `FROM issues i JOIN repos r ON r.full_name = i.repo WHERE r.workspace_id = ?`;
    const facets = {
      authors: (this.db.prepare(`SELECT DISTINCT i.author AS v ${facetBase} AND i.author != '' ORDER BY 1`).all(workspaceId) as Array<{ v: string }>).map((r) => r.v),
      assignees: (this.db.prepare(`SELECT DISTINCT json_each.value AS v ${facetBase.replace('WHERE', ', json_each(i.assignees) WHERE')} ORDER BY 1`).all(workspaceId) as Array<{ v: string }>).map((r) => r.v),
      labels: (this.db.prepare(`SELECT DISTINCT json_each.value AS v ${facetBase.replace('WHERE', ', json_each(i.labels) WHERE')} ORDER BY 1`).all(workspaceId) as Array<{ v: string }>).map((r) => r.v),
    };
    return { issues, total, counts, facets };
  }

  /** Paged/filtered PRs with per-state counts (for tab chips). */
  listWorkspacePrsPaged(
    workspaceId: string,
    state: 'open' | 'merged' | 'closed' | undefined,
    opts: {
      q?: string;
      repo?: string;
      author?: string;
      assignee?: string;
      decision?: 'approved' | 'changes_requested' | 'none';
      draft?: 'hide' | 'only';
      limit?: number;
      offset?: number;
    },
  ): {
    prs: PrRecord[];
    total: number;
    counts: { open: number; merged: number; closed: number };
    facets: { authors: string[]; assignees: string[] };
  } {
    const where: string[] = ['r.workspace_id = ?'];
    const args: unknown[] = [workspaceId];
    if (opts.repo) {
      where.push('p.repo = ?');
      args.push(opts.repo);
    }
    if (opts.author) {
      where.push('p.author = ?');
      args.push(opts.author);
    }
    if (opts.assignee === '__none') {
      where.push(`p.assignees = '[]'`);
    } else if (opts.assignee) {
      where.push(`EXISTS (SELECT 1 FROM json_each(p.assignees) WHERE json_each.value = ?)`);
      args.push(opts.assignee);
    }
    if (opts.decision === 'none') {
      where.push('p.review_decision IS NULL');
    } else if (opts.decision) {
      where.push('p.review_decision = ?');
      args.push(opts.decision);
    }
    if (opts.draft === 'hide') where.push('p.draft = 0');
    else if (opts.draft === 'only') where.push('p.draft = 1');
    if (opts.q) {
      where.push(`(p.title LIKE ? ESCAPE '\\' OR p.author LIKE ? ESCAPE '\\' OR CAST(p.number AS TEXT) = ?)`);
      const like = likeArg(opts.q);
      args.push(like, like, opts.q.replace(/^#/, ''));
    }
    const base = `FROM prs p JOIN repos r ON r.full_name = p.repo WHERE ${where.join(' AND ')}`;
    const counts = { open: 0, merged: 0, closed: 0 };
    for (const row of this.db.prepare(`SELECT p.state AS state, COUNT(*) AS n ${base} GROUP BY p.state`).all(...args) as Array<{ state: string; n: number }>) {
      if (row.state === 'open' || row.state === 'merged' || row.state === 'closed') counts[row.state] = row.n;
    }
    const stateCond = state ? ` AND p.state = ?` : '';
    const stateArgs = state ? [...args, state] : args;
    const rows = this.db
      .prepare(`SELECT p.* ${base}${stateCond} ORDER BY p.updated_at DESC LIMIT ? OFFSET ?`)
      .all(...stateArgs, opts.limit ?? -1, opts.offset ?? 0) as PrRow[];
    const reviewsByRepo = new Map<string, Map<number, PrReviewResult['status']>>();
    const prs = rows.map((row) => {
      let map = reviewsByRepo.get(row.repo);
      if (!map) {
        map = this.latestPrReviewByNumber(row.repo);
        reviewsByRepo.set(row.repo, map);
      }
      return prRowToRecord(row, map.get(row.number) ?? null);
    });
    const total = state ? counts[state] : counts.open + counts.merged + counts.closed;
    const facetBase = `FROM prs p JOIN repos r ON r.full_name = p.repo WHERE r.workspace_id = ?`;
    const facets = {
      authors: (this.db.prepare(`SELECT DISTINCT p.author AS v ${facetBase} AND p.author != '' ORDER BY 1`).all(workspaceId) as Array<{ v: string }>).map((r) => r.v),
      assignees: (this.db.prepare(`SELECT DISTINCT json_each.value AS v ${facetBase.replace('WHERE', ', json_each(p.assignees) WHERE')} ORDER BY 1`).all(workspaceId) as Array<{ v: string }>).map((r) => r.v),
    };
    return { prs, total, counts, facets };
  }

  listWorkspaceProposals(workspaceId: string): ProposalRecord[] {
    const rows = this.db
      .prepare(
        `SELECT p.* FROM proposals p JOIN repos r ON r.full_name = p.repo
         WHERE r.workspace_id = ? ORDER BY p.created_at DESC`,
      )
      .all(workspaceId) as ProposalRow[];
    return rows.map(proposalRowToRecord);
  }

  /** Counters + weekly open/close velocity for a workspace's dashboard. */
  workspaceMetrics(workspaceId: string, weeks = 8): WorkspaceMetrics {
    const issues = this.db
      .prepare(
        `SELECT i.state, i.created_at, i.closed_at FROM issues i
         JOIN repos r ON r.full_name = i.repo WHERE r.workspace_id = ?`,
      )
      .all(workspaceId) as Array<{ state: string; created_at: number; closed_at: number | null }>;
    const prs = this.db
      .prepare(
        `SELECT p.state, p.created_at, p.closed_at FROM prs p
         JOIN repos r ON r.full_name = p.repo WHERE r.workspace_id = ?`,
      )
      .all(workspaceId) as Array<{ state: string; created_at: number; closed_at: number | null }>;

    // Monday-start calendar weeks, local time, oldest → newest.
    const monday = new Date();
    monday.setHours(0, 0, 0, 0);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const starts: number[] = [];
    for (let i = weeks - 1; i >= 0; i--) {
      starts.push(monday.getTime() - i * 7 * 86_400_000);
    }
    const bucket = (ts: number | null): number => {
      if (ts === null) return -1;
      if (ts < starts[0]!) return -1;
      for (let i = starts.length - 1; i >= 0; i--) {
        if (ts >= starts[i]!) return i;
      }
      return -1;
    };

    const weekly = starts.map((weekStart) => ({
      weekStart,
      issuesOpened: 0,
      issuesClosed: 0,
      prsOpened: 0,
      prsClosed: 0,
    }));
    for (const i of issues) {
      const opened = bucket(i.created_at);
      if (opened >= 0) weekly[opened]!.issuesOpened++;
      const closed = bucket(i.closed_at);
      if (closed >= 0) weekly[closed]!.issuesClosed++;
    }
    for (const p of prs) {
      const opened = bucket(p.created_at);
      if (opened >= 0) weekly[opened]!.prsOpened++;
      const closed = bucket(p.closed_at);
      if (closed >= 0) weekly[closed]!.prsClosed++;
    }

    const thisWeek = weekly[weekly.length - 1]!;
    return {
      openIssues: issues.filter((i) => i.state === 'open').length,
      closedIssues: issues.filter((i) => i.state === 'closed').length,
      openPrs: prs.filter((p) => p.state === 'open').length,
      mergedPrs: prs.filter((p) => p.state === 'merged').length,
      issuesOpenedThisWeek: thisWeek.issuesOpened,
      issuesClosedThisWeek: thisWeek.issuesClosed,
      prsOpenedThisWeek: thisWeek.prsOpened,
      prsClosedThisWeek: thisWeek.prsClosed,
      weekly,
    };
  }

  // ---------- pr reviews ----------------------------------------------------------

  insertPrReview(r: PrReviewResult): void {
    this.db
      .prepare(
        `INSERT INTO pr_reviews (id, repo, pr_number, run_id, status, verdict, error, created_at)
         VALUES (@id, @repo, @prNumber, @runId, @status, @verdict, @error, @createdAt)`,
      )
      .run({ ...r, verdict: r.verdict ? JSON.stringify(r.verdict) : null });
  }

  updatePrReview(id: string, status: PrReviewResult['status']): void {
    this.db.prepare(`UPDATE pr_reviews SET status = ? WHERE id = ?`).run(status, id);
  }

  getPrReview(id: string): PrReviewResult | undefined {
    const row = this.db.prepare(`SELECT * FROM pr_reviews WHERE id = ?`).get(id) as PrReviewRow | undefined;
    return row ? prReviewRowToResult(row) : undefined;
  }

  latestPrReview(repo: string, prNumber: number): PrReviewResult | undefined {
    const row = this.db
      .prepare(`SELECT * FROM pr_reviews WHERE repo = ? AND pr_number = ? ORDER BY created_at DESC LIMIT 1`)
      .get(repo, prNumber) as PrReviewRow | undefined;
    return row ? prReviewRowToResult(row) : undefined;
  }

  private latestPrReviewByNumber(repo: string): Map<number, PrReviewResult['status']> {
    const rows = this.db
      .prepare(
        `SELECT pr_number, status FROM pr_reviews t1 WHERE repo = ?
         AND created_at = (SELECT MAX(created_at) FROM pr_reviews t2 WHERE t2.repo = t1.repo AND t2.pr_number = t1.pr_number)`,
      )
      .all(repo) as Array<{ pr_number: number; status: PrReviewResult['status'] }>;
    return new Map(rows.map((r) => [r.pr_number, r.status]));
  }

  // ---------- triage ---------------------------------------------------------------

  insertTriage(t: TriageResult): void {
    this.db
      .prepare(
        `INSERT INTO triage_results (id, repo, issue_number, run_id, status, verdict, error, created_at)
         VALUES (@id, @repo, @issueNumber, @runId, @status, @verdict, @error, @createdAt)`,
      )
      .run({ ...t, verdict: t.verdict ? JSON.stringify(t.verdict) : null });
  }

  updateTriage(id: string, status: TriageResult['status'], verdict?: TriageVerdict | null, error?: string | null): void {
    this.db
      .prepare(
        `UPDATE triage_results SET status = ?, verdict = COALESCE(?, verdict), error = COALESCE(?, error) WHERE id = ?`,
      )
      .run(status, verdict ? JSON.stringify(verdict) : null, error ?? null, id);
  }

  latestTriage(repo: string, issueNumber: number): TriageResult | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM triage_results WHERE repo = ? AND issue_number = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(repo, issueNumber) as TriageRow | undefined;
    return row ? triageRowToResult(row) : undefined;
  }

  listTriage(repo: string, status?: TriageResult['status']): TriageResult[] {
    const rows = (
      status
        ? this.db.prepare(`SELECT * FROM triage_results WHERE repo = ? AND status = ? ORDER BY created_at DESC`).all(repo, status)
        : this.db.prepare(`SELECT * FROM triage_results WHERE repo = ? ORDER BY created_at DESC`).all(repo)
    ) as TriageRow[];
    return rows.map(triageRowToResult);
  }

  private latestTriageByIssue(repo: string): Map<number, TriageResult['status']> {
    const rows = this.db
      .prepare(
        `SELECT issue_number, status FROM triage_results t1 WHERE repo = ?
         AND created_at = (SELECT MAX(created_at) FROM triage_results t2 WHERE t2.repo = t1.repo AND t2.issue_number = t1.issue_number)`,
      )
      .all(repo) as Array<{ issue_number: number; status: TriageResult['status'] }>;
    return new Map(rows.map((r) => [r.issue_number, r.status]));
  }

  // ---------- proposals --------------------------------------------------------------

  insertProposal(p: ProposalRecord): void {
    this.db
      .prepare(
        `INSERT INTO proposals (id, repo, title, body, status, analysis, analysis_run_id, implement_run_id, branch, pr_url, created_at, updated_at)
         VALUES (@id, @repo, @title, @body, @status, @analysis, @analysisRunId, @implementRunId, @branch, @prUrl, @createdAt, @updatedAt)`,
      )
      .run({ ...p, analysis: p.analysis ? JSON.stringify(p.analysis) : null });
  }

  updateProposal(
    id: string,
    fields: Partial<{
      status: ProposalRecord['status'];
      analysis: ProposalAnalysis | null;
      analysisRunId: string;
      implementRunId: string;
      branch: string;
      prUrl: string;
    }>,
  ): void {
    const current = this.getProposal(id);
    if (!current) return;
    const next = { ...current, ...fields, updatedAt: Date.now() };
    this.db
      .prepare(
        `UPDATE proposals SET status = @status, analysis = @analysis, analysis_run_id = @analysisRunId,
         implement_run_id = @implementRunId, branch = @branch, pr_url = @prUrl, updated_at = @updatedAt WHERE id = @id`,
      )
      .run({
        id,
        status: next.status,
        analysis: next.analysis ? JSON.stringify(next.analysis) : null,
        analysisRunId: next.analysisRunId,
        implementRunId: next.implementRunId,
        branch: next.branch,
        prUrl: next.prUrl,
        updatedAt: next.updatedAt,
      });
  }

  getProposal(id: string): ProposalRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM proposals WHERE id = ?`).get(id) as ProposalRow | undefined;
    return row ? proposalRowToRecord(row) : undefined;
  }

  listProposals(): ProposalRecord[] {
    const rows = this.db.prepare(`SELECT * FROM proposals ORDER BY created_at DESC`).all() as ProposalRow[];
    return rows.map(proposalRowToRecord);
  }

  /**
   * Boot sweep: an 'analyzing' proposal whose one-shot driver died with the
   * previous daemon process would dangle forever — put it back to draft so
   * the Analyze action is available again.
   */
  resetDanglingProposalAnalyses(): number {
    const result = this.db
      .prepare(`UPDATE proposals SET status = 'draft', updated_at = ? WHERE status = 'analyzing'`)
      .run(Date.now());
    return result.changes;
  }

  // ---------- pipelines ------------------------------------------------------------

  insertPipeline(p: PipelineRecord): void {
    this.db
      .prepare(
        `INSERT INTO pipelines (id, workspace_id, type, name, description, steps, auto_run, created_at, updated_at)
         VALUES (@id, @workspaceId, @type, @name, @description, @steps, @autoRun, @createdAt, @updatedAt)`,
      )
      .run({
        id: p.id,
        workspaceId: p.workspaceId,
        type: p.type,
        name: p.name,
        description: p.description,
        steps: JSON.stringify(p.steps),
        autoRun: p.autoRunOnPrOpen ? 1 : 0,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      });
  }

  updatePipeline(
    id: string,
    fields: {
      type?: string;
      name?: string;
      description?: string;
      steps?: ReadonlyArray<PipelineStepSpec>;
      autoRunOnPrOpen?: boolean;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE pipelines SET
           type = COALESCE(@type, type),
           name = COALESCE(@name, name),
           description = COALESCE(@description, description),
           steps = COALESCE(@steps, steps),
           auto_run = COALESCE(@autoRun, auto_run),
           updated_at = @updatedAt
         WHERE id = @id`,
      )
      .run({
        id,
        type: fields.type ?? null,
        name: fields.name ?? null,
        description: fields.description ?? null,
        steps: fields.steps ? JSON.stringify(fields.steps) : null,
        autoRun: fields.autoRunOnPrOpen === undefined ? null : fields.autoRunOnPrOpen ? 1 : 0,
        updatedAt: Date.now(),
      });
  }

  getPipeline(id: string): PipelineRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM pipelines WHERE id = ?`).get(id) as PipelineRow | undefined;
    return row ? pipelineRowToRecord(row) : undefined;
  }

  listPipelines(workspaceId: string): PipelineRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM pipelines WHERE workspace_id = ? ORDER BY name`)
      .all(workspaceId) as PipelineRow[];
    return rows.map(pipelineRowToRecord);
  }

  deletePipeline(id: string): void {
    this.db.prepare(`DELETE FROM pipelines WHERE id = ?`).run(id);
  }

  // ---------- step definitions (custom step library) --------------------------------

  insertStepDefinition(d: StepDefinitionRecord): void {
    this.db
      .prepare(
        `INSERT INTO step_definitions (id, workspace_id, name, description, step, created_at, updated_at)
         VALUES (@id, @workspaceId, @name, @description, @step, @createdAt, @updatedAt)`,
      )
      .run({
        id: d.id,
        workspaceId: d.workspaceId,
        name: d.name,
        description: d.description,
        step: JSON.stringify(d.step),
        createdAt: d.createdAt,
        updatedAt: d.updatedAt,
      });
  }

  updateStepDefinition(
    id: string,
    fields: { name?: string; description?: string; step?: PipelineStep },
  ): void {
    this.db
      .prepare(
        `UPDATE step_definitions SET
           name = COALESCE(@name, name),
           description = COALESCE(@description, description),
           step = COALESCE(@step, step),
           updated_at = @updatedAt
         WHERE id = @id`,
      )
      .run({
        id,
        name: fields.name ?? null,
        description: fields.description ?? null,
        step: fields.step ? JSON.stringify(fields.step) : null,
        updatedAt: Date.now(),
      });
  }

  getStepDefinition(id: string): StepDefinitionRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM step_definitions WHERE id = ?`).get(id) as
      | StepDefinitionRow
      | undefined;
    return row ? stepDefinitionRowToRecord(row) : undefined;
  }

  listStepDefinitions(workspaceId: string): StepDefinitionRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM step_definitions WHERE workspace_id = ? ORDER BY name`)
      .all(workspaceId) as StepDefinitionRow[];
    return rows.map(stepDefinitionRowToRecord).filter((d): d is StepDefinitionRecord => d !== undefined);
  }

  deleteStepDefinition(id: string): void {
    this.db.prepare(`DELETE FROM step_definitions WHERE id = ?`).run(id);
  }

  // ---------- pipeline runs -----------------------------------------------------------

  insertPipelineRun(r: PipelineRunRecord): void {
    this.db
      .prepare(
        `INSERT INTO pipeline_runs (id, pipeline_id, pipeline_name, target, repo, pr_number, status, trigger, steps, created_at, finished_at)
         VALUES (@id, @pipelineId, @pipelineName, @target, @repo, @prNumber, @status, @trigger, @steps, @createdAt, @finishedAt)`,
      )
      .run({
        id: r.id,
        pipelineId: r.pipelineId,
        pipelineName: r.pipelineName,
        target: r.target,
        repo: r.repo,
        prNumber: r.prNumber,
        status: r.status,
        trigger: r.trigger,
        steps: JSON.stringify(r.steps),
        createdAt: r.createdAt,
        finishedAt: r.finishedAt,
      });
  }

  updatePipelineRun(
    id: string,
    fields: {
      status?: PipelineRunStatus;
      steps?: ReadonlyArray<PipelineStepResult>;
      finishedAt?: number | null;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE pipeline_runs SET
           status = COALESCE(@status, status),
           steps = COALESCE(@steps, steps),
           finished_at = COALESCE(@finishedAt, finished_at)
         WHERE id = @id`,
      )
      .run({
        id,
        status: fields.status ?? null,
        steps: fields.steps ? JSON.stringify(fields.steps) : null,
        finishedAt: fields.finishedAt ?? null,
      });
  }

  getPipelineRun(id: string): PipelineRunRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM pipeline_runs WHERE id = ?`).get(id) as
      | PipelineRunRow
      | undefined;
    return row ? pipelineRunRowToRecord(row) : undefined;
  }

  listPipelineRunsForIssue(repo: string, issueNumber: number, limit = 50): PipelineRunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM pipeline_runs WHERE repo = ? AND pr_number = ? AND target = 'issue' ORDER BY created_at DESC LIMIT ?`,
      )
      .all(repo, issueNumber, limit) as PipelineRunRow[];
    return rows.map(pipelineRunRowToRecord);
  }

  listPipelineRunsForPr(repo: string, prNumber: number, limit = 50): PipelineRunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM pipeline_runs WHERE repo = ? AND pr_number = ? AND target = 'pr' ORDER BY created_at DESC LIMIT ?`,
      )
      .all(repo, prNumber, limit) as PipelineRunRow[];
    return rows.map(pipelineRunRowToRecord);
  }

  listWorkspacePipelineRuns(workspaceId: string, limit = 100): PipelineRunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT pr.* FROM pipeline_runs pr JOIN repos r ON r.full_name = pr.repo
         WHERE r.workspace_id = ? ORDER BY pr.created_at DESC LIMIT ?`,
      )
      .all(workspaceId, limit) as PipelineRunRow[];
    return rows.map(pipelineRunRowToRecord);
  }

  /** Boot sweep: runs left 'running' by a dead daemon are errors. */
  markInterruptedPipelineRuns(): number {
    const result = this.db
      .prepare(`UPDATE pipeline_runs SET status = 'error', finished_at = ? WHERE status = 'running'`)
      .run(Date.now());
    return result.changes;
  }

  // ---------- reports ------------------------------------------------------------------

  insertReport(r: ReportRecord): void {
    this.db
      .prepare(
        `INSERT INTO reports (id, repo, issue_number, kind, title, body, created_at)
         VALUES (@id, @repo, @issueNumber, @kind, @title, @body, @createdAt)`,
      )
      .run(r);
  }

  listReports(limit = 100): ReportRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM reports ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as ReportRow[];
    return rows.map(reportRowToRecord);
  }

  /** Latest report of a kind for a specific issue/PR (ci-analysis lookups). */
  latestReportFor(repo: string, issueNumber: number, kind: ReportRecord['kind']): ReportRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM reports WHERE repo = ? AND issue_number = ? AND kind = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(repo, issueNumber, kind) as ReportRow | undefined;
    return row ? reportRowToRecord(row) : null;
  }
}

// ---------- row mappers -----------------------------------------------------------

export interface RunRow {
  id: string;
  kind: RunKind;
  status: RunStatus;
  title: string;
  cwd: string;
  repo: string | null;
  issue_number: number | null;
  proposal_id: string | null;
  branch: string | null;
  pr_url: string | null;
  model: string | null;
  created_at: number;
  updated_at: number;
  input_tokens: number;
  output_tokens: number;
  outcome: string | null;
}

export interface RepoRow {
  full_name: string;
  owner: string;
  name: string;
  workspace_id: string;
  github_account_id: string | null;
  default_branch: string;
  private: number;
  clone_ready: number;
  last_sync_at: number | null;
  auto_triage: number;
  digest_enabled: number;
  stale_enabled: number;
  pr_gate: number;
  webhook_secret: string | null;
}

interface WorkspaceRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  created_at: number;
  repo_count: number;
}

interface UserRow {
  username: string;
  email: string;
  password_hash: string;
  role: Role;
  disabled: number;
  created_at: number;
}

interface ReportRow {
  id: string;
  repo: string | null;
  issue_number: number | null;
  kind: ReportRecord['kind'];
  title: string;
  body: string;
  created_at: number;
}

function userRowToRecord(row: UserRow): UserRecord {
  return {
    username: row.username,
    email: row.email,
    role: row.role,
    disabled: row.disabled === 1,
    createdAt: row.created_at,
  };
}

function reportRowToRecord(row: ReportRow): ReportRecord {
  return {
    id: row.id,
    repo: row.repo,
    issueNumber: row.issue_number,
    kind: row.kind,
    title: row.title,
    body: row.body,
    createdAt: row.created_at,
  };
}

interface PrRow {
  repo: string;
  number: number;
  title: string;
  body: string;
  state: string;
  head_ref: string;
  head_sha: string | null;
  base_ref: string;
  draft: number;
  author: string;
  labels: string;
  assignees: string;
  comments: number;
  review_decision: string | null;
  url: string;
  checks: string | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

interface PipelineRow {
  id: string;
  workspace_id: string;
  type: string;
  name: string;
  description: string;
  steps: string;
  auto_run: number;
  created_at: number;
  updated_at: number;
}

interface StepDefinitionRow {
  id: string;
  workspace_id: string;
  name: string;
  description: string;
  step: string;
  created_at: number;
  updated_at: number;
}

interface PipelineRunRow {
  id: string;
  pipeline_id: string;
  pipeline_name: string;
  target: string;
  repo: string;
  pr_number: number;
  status: PipelineRunStatus;
  trigger: PipelineTrigger;
  steps: string;
  created_at: number;
  finished_at: number | null;
}

interface PrReviewRow {
  id: string;
  repo: string;
  pr_number: number;
  run_id: string;
  status: PrReviewResult['status'];
  verdict: string | null;
  error: string | null;
  created_at: number;
}

function prRowToRecord(row: PrRow, review: PrReviewResult['status'] | null): PrRecord {
  return {
    repo: row.repo,
    number: row.number,
    title: row.title,
    body: row.body,
    state: row.state as PrRecord['state'],
    headRef: row.head_ref,
    headSha: row.head_sha,
    baseRef: row.base_ref,
    draft: row.draft === 1,
    author: row.author,
    labels: safeParse<string[]>(row.labels ?? '[]', []),
    assignees: safeParse<string[]>(row.assignees ?? '[]', []),
    comments: row.comments ?? 0,
    url: row.url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    review: review === 'failed' ? null : review,
    reviewDecision:
      row.review_decision === 'approved' || row.review_decision === 'changes_requested' ? row.review_decision : null,
    checks: row.checks ? safeParse<ChecksSnapshot | null>(row.checks, null) : null,
  };
}

function workspaceRowToRecord(row: WorkspaceRow): WorkspaceRecord {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    createdAt: row.created_at,
    repoCount: row.repo_count,
  };
}

function pipelineRowToRecord(row: PipelineRow): PipelineRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    type: row.type === 'issue' || row.type === 'platform' ? row.type : 'pr',
    name: row.name,
    description: row.description,
    steps: safeParse<PipelineStepSpec[]>(row.steps, []),
    autoRunOnPrOpen: row.auto_run === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function stepDefinitionRowToRecord(row: StepDefinitionRow): StepDefinitionRecord | undefined {
  const step = safeParse<PipelineStep | null>(row.step, null);
  if (!step) return undefined;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    description: row.description,
    step,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function pipelineRunRowToRecord(row: PipelineRunRow): PipelineRunRecord {
  return {
    id: row.id,
    pipelineId: row.pipeline_id,
    pipelineName: row.pipeline_name,
    target: row.target === 'issue' || row.target === 'platform' ? row.target : 'pr',
    repo: row.repo,
    prNumber: row.pr_number,
    status: row.status,
    trigger: row.trigger,
    steps: safeParse<PipelineStepResult[]>(row.steps, []),
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

function prReviewRowToResult(row: PrReviewRow): PrReviewResult {
  return {
    id: row.id,
    repo: row.repo,
    prNumber: row.pr_number,
    runId: row.run_id,
    status: row.status,
    verdict: row.verdict ? safeParse<PrReviewVerdict | null>(row.verdict, null) : null,
    error: row.error,
    createdAt: row.created_at,
  };
}

interface IssueRow {
  repo: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string;
  author: string;
  assignees: string;
  comments: number;
  url: string;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

interface TriageRow {
  id: string;
  repo: string;
  issue_number: number;
  run_id: string;
  status: TriageResult['status'];
  verdict: string | null;
  error: string | null;
  created_at: number;
}

interface ProposalRow {
  id: string;
  repo: string;
  title: string;
  body: string;
  status: ProposalRecord['status'];
  analysis: string | null;
  analysis_run_id: string | null;
  implement_run_id: string | null;
  branch: string | null;
  pr_url: string | null;
  created_at: number;
  updated_at: number;
}

/** Escape %/_ so user input matches literally in LIKE queries. */
function likeArg(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

export interface GithubAccountRow {
  id: string;
  login: string;
  token: string;
  purposes: GitHubPurpose[];
  createdAt: number;
}

interface NotificationRow {
  id: string;
  workspace_id: string | null;
  kind: string;
  title: string;
  body: string;
  href: string | null;
  read_at: number | null;
  created_at: number;
}

function rowToNotification(row: NotificationRow): NotificationRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind as NotificationRecord['kind'],
    title: row.title,
    body: row.body,
    href: row.href,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

export function rowToRun(row: RunRow, live: boolean): RunRecord {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    title: row.title,
    cwd: row.cwd,
    repo: row.repo,
    issueNumber: row.issue_number,
    proposalId: row.proposal_id,
    branch: row.branch,
    prUrl: row.pr_url,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    live,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    outcome: row.outcome,
  };
}

export function rowToRepo(row: RepoRow): RepoRecord {
  return {
    githubAccountId: row.github_account_id ?? null,
    fullName: row.full_name,
    owner: row.owner,
    name: row.name,
    workspaceId: row.workspace_id,
    defaultBranch: row.default_branch,
    private: row.private === 1,
    cloneReady: row.clone_ready === 1,
    lastSyncAt: row.last_sync_at,
    openIssues: 0, // filled by callers that have the count
    autoTriage: row.auto_triage === 1,
    digestEnabled: row.digest_enabled === 1,
    staleSweepEnabled: row.stale_enabled === 1,
    prGateEnabled: row.pr_gate === 1,
    webhookConfigured: row.webhook_secret !== null,
  };
}

function issueRowToRecord(row: IssueRow, triage: TriageResult['status'] | null): IssueRecord {
  return {
    repo: row.repo,
    number: row.number,
    title: row.title,
    body: row.body,
    state: row.state,
    labels: safeParse(row.labels, []),
    author: row.author,
    assignees: safeParse(row.assignees, []),
    comments: row.comments,
    url: row.url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    triage: triage === 'failed' ? null : triage,
  };
}

function triageRowToResult(row: TriageRow): TriageResult {
  return {
    id: row.id,
    repo: row.repo,
    issueNumber: row.issue_number,
    runId: row.run_id,
    status: row.status,
    verdict: row.verdict ? safeParse<TriageVerdict | null>(row.verdict, null) : null,
    error: row.error,
    createdAt: row.created_at,
  };
}

function proposalRowToRecord(row: ProposalRow): ProposalRecord {
  return {
    id: row.id,
    repo: row.repo,
    title: row.title,
    body: row.body,
    status: row.status,
    analysis: row.analysis ? safeParse<ProposalAnalysis | null>(row.analysis, null) : null,
    analysisRunId: row.analysis_run_id,
    implementRunId: row.implement_run_id,
    branch: row.branch,
    prUrl: row.pr_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
