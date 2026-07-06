import Database from 'better-sqlite3';
import type {
  IssueRecord,
  PrRecord,
  PrReviewResult,
  PrReviewVerdict,
  ProposalAnalysis,
  ProposalRecord,
  ReportRecord,
  RepoRecord,
  RunKind,
  RunRecord,
  RunStatus,
  TriageResult,
  TriageVerdict,
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
    // Additive columns on pre-existing tables (CREATE TABLE IF NOT EXISTS won't add them).
    for (const ddl of [
      `ALTER TABLE runs ADD COLUMN proposal_id TEXT`,
      `ALTER TABLE runs ADD COLUMN branch TEXT`,
      `ALTER TABLE runs ADD COLUMN pr_url TEXT`,
      `ALTER TABLE prs ADD COLUMN body TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE prs ADD COLUMN base_ref TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE prs ADD COLUMN draft INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE repos ADD COLUMN pr_gate INTEGER NOT NULL DEFAULT 0`,
    ]) {
      try {
        this.db.exec(ddl);
      } catch {
        // column already exists
      }
    }
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

  // ---------- runs ------------------------------------------------------------

  insertRun(run: Omit<RunRecord, 'live'>): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, kind, status, title, cwd, repo, issue_number, proposal_id, branch, pr_url, created_at, updated_at, input_tokens, output_tokens, outcome)
         VALUES (@id, @kind, @status, @title, @cwd, @repo, @issueNumber, @proposalId, @branch, @prUrl, @createdAt, @updatedAt, @inputTokens, @outputTokens, @outcome)`,
      )
      .run(run);
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
  }): void {
    this.db
      .prepare(
        `INSERT INTO repos (full_name, owner, name, default_branch, private)
         VALUES (@fullName, @owner, @name, @defaultBranch, @isPrivate)
         ON CONFLICT(full_name) DO UPDATE SET default_branch = excluded.default_branch, private = excluded.private`,
      )
      .run({ ...repo, isPrivate: repo.private ? 1 : 0 });
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
        `INSERT INTO issues (repo, number, title, body, state, labels, author, assignees, comments, url, created_at, updated_at)
         VALUES (@repo, @number, @title, @body, @state, @labels, @author, @assignees, @comments, @url, @createdAt, @updatedAt)
         ON CONFLICT(repo, number) DO UPDATE SET
           title = excluded.title, body = excluded.body, state = excluded.state,
           labels = excluded.labels, author = excluded.author, assignees = excluded.assignees,
           comments = excluded.comments, url = excluded.url, updated_at = excluded.updated_at`,
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

  upsertPr(pr: Omit<PrRecord, 'review'>): void {
    this.db
      .prepare(
        `INSERT INTO prs (repo, number, title, body, state, head_ref, base_ref, draft, author, url, created_at, updated_at)
         VALUES (@repo, @number, @title, @body, @state, @headRef, @baseRef, @isDraft, @author, @url, @createdAt, @updatedAt)
         ON CONFLICT(repo, number) DO UPDATE SET
           title = excluded.title, body = excluded.body, state = excluded.state,
           head_ref = excluded.head_ref, base_ref = excluded.base_ref, draft = excluded.draft,
           author = excluded.author, url = excluded.url, updated_at = excluded.updated_at`,
      )
      .run({ ...pr, isDraft: pr.draft ? 1 : 0 });
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

  // ---------- reports ------------------------------------------------------------------

  insertReport(r: ReportRecord): void {
    this.db
      .prepare(
        `INSERT INTO reports (id, repo, kind, title, body, created_at)
         VALUES (@id, @repo, @kind, @title, @body, @createdAt)`,
      )
      .run(r);
  }

  listReports(limit = 100): ReportRecord[] {
    const rows = this.db.prepare(`SELECT * FROM reports ORDER BY created_at DESC LIMIT ?`).all(limit) as Array<{
      id: string;
      repo: string | null;
      kind: ReportRecord['kind'];
      title: string;
      body: string;
      created_at: number;
    }>;
    return rows.map((r) => ({ id: r.id, repo: r.repo, kind: r.kind, title: r.title, body: r.body, createdAt: r.created_at }));
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

interface PrRow {
  repo: string;
  number: number;
  title: string;
  body: string;
  state: string;
  head_ref: string;
  base_ref: string;
  draft: number;
  author: string;
  url: string;
  created_at: number;
  updated_at: number;
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
    baseRef: row.base_ref,
    draft: row.draft === 1,
    author: row.author,
    url: row.url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    review: review === 'failed' ? null : review,
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
    fullName: row.full_name,
    owner: row.owner,
    name: row.name,
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
