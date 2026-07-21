import type Database from 'better-sqlite3';
import type { RunKind, RunRecord, RunStatus } from '../contract/index.js';

/** Agent runs — rows are the source of truth; gateway processes are cattle. */
export class RunsStore {
  constructor(private readonly db: Database.Database) {}

  insert(run: Omit<RunRecord, 'live'>): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, kind, status, title, cwd, repo, issue_number, proposal_id, branch, pr_url, model, runner_id, user_id, created_at, updated_at, input_tokens, output_tokens, outcome)
         VALUES (@id, @kind, @status, @title, @cwd, @repo, @issueNumber, @proposalId, @branch, @prUrl, @model, @runnerId, @userId, @createdAt, @updatedAt, @inputTokens, @outputTokens, @outcome)`,
      )
      .run(run);
  }

  /** Set the run's cwd + runner after placement (before the gateway spawns). */
  setPlacement(id: string, runnerId: string | null, cwd: string): void {
    this.db.prepare(`UPDATE runs SET runner_id = ?, cwd = ?, updated_at = ? WHERE id = ?`).run(runnerId, cwd, Date.now(), id);
  }

  setModel(id: string, model: string | null): void {
    this.db.prepare(`UPDATE runs SET model = ?, updated_at = ? WHERE id = ?`).run(model, Date.now(), id);
  }

  updateStatus(id: string, status: RunStatus, outcome?: string | null): void {
    this.db
      .prepare(
        `UPDATE runs SET status = ?, outcome = COALESCE(?, outcome), updated_at = ? WHERE id = ?`,
      )
      .run(status, outcome ?? null, Date.now(), id);
  }

  setPr(id: string, branch: string | null, prUrl: string | null): void {
    this.db
      .prepare(`UPDATE runs SET branch = COALESCE(?, branch), pr_url = COALESCE(?, pr_url), updated_at = ? WHERE id = ?`)
      .run(branch, prUrl, Date.now(), id);
  }

  addUsage(id: string, inputTokens: number, outputTokens: number): void {
    this.db
      .prepare(
        `UPDATE runs SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, updated_at = ? WHERE id = ?`,
      )
      .run(inputTokens, outputTokens, Date.now(), id);
  }

  get(id: string): RunRow | undefined {
    return this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as RunRow | undefined;
  }

  list(limit = 200): RunRow[] {
    return this.db
      .prepare(`SELECT * FROM runs ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as RunRow[];
  }

  /**
   * Non-terminal run counts per runner (key: runner_id, null = local). Used by
   * placement so a batch spreads across runners by the runs already assigned to
   * each — not just the gateways that have actually spawned yet.
   */
  activeCountsByRunner(): Map<string | null, number> {
    const rows = this.db
      .prepare(
        `SELECT runner_id AS r, COUNT(*) AS n FROM runs
         WHERE status IN ('provisioning', 'running', 'idle', 'review') GROUP BY runner_id`,
      )
      .all() as Array<{ r: string | null; n: number }>;
    const counts = new Map<string | null, number>();
    for (const row of rows) counts.set(row.r, row.n);
    return counts;
  }

  /**
   * Live attended chats (interactive + AI Help) holding a slot of the pool the
   * given user schedules against: shared runners (runner_id null = local) plus
   * the user's own machines. A colleague's chats parked on THEIR personal
   * runner must not eat this user's headroom — the capacities don't overlap.
   */
  activeInteractiveCount(userId: string | null = null): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM runs r
           WHERE r.kind IN ('interactive', 'assistant')
             AND r.status IN ('provisioning', 'running', 'idle', 'review')
             AND (r.runner_id IS NULL OR EXISTS (
               SELECT 1 FROM runners k WHERE k.id = r.runner_id
                 AND (k.owner_id IS NULL OR k.owner_id = @userId)))`,
        )
        .get({ userId }) as { n: number }
    ).n;
  }

  /**
   * Live runs that DON'T flow through the unattended queue — attended chats plus
   * fix/implement runs started directly. The scheduler adds these to its own
   * in-flight count so it never overcommits the runner pool. Runs placed on a
   * personally-owned runner are excluded: they don't occupy shared capacity,
   * and counting them would starve the queue while shared runners sit idle.
   */
  activeNonQueueCount(): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM runs r
           WHERE r.kind IN ('interactive', 'assistant', 'fix', 'implement')
             AND r.status IN ('provisioning', 'running', 'idle', 'review')
             AND (r.runner_id IS NULL OR EXISTS (
               SELECT 1 FROM runners k WHERE k.id = r.runner_id AND k.owner_id IS NULL))`,
        )
        .get() as { n: number }
    ).n;
  }

  /** Repos with runs in the window — the bounded pre-resolve for usage visibility. */
  distinctReposSince(since: number): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT repo AS r FROM runs WHERE created_at >= ? AND repo IS NOT NULL`)
      .all(since) as Array<{ r: string }>;
    return rows.map((row) => row.r);
  }

  /**
   * OperateService.canSeeRun resolved to a SQL clause, shared by the usage
   * aggregates: null scope = no restriction (admin); otherwise the viewer's
   * own attended chats, repo-less automated runs, and runs on the
   * pre-resolved accessible repos.
   */
  private usageWhere(scope: UsageScope): { clause: string; params: Array<string | number> } {
    if (scope === null) return { clause: '', params: [] };
    const inRepos = scope.repos.length > 0 ? ` OR repo IN (${scope.repos.map(() => '?').join(', ')})` : '';
    return {
      clause: ` AND (
        (kind IN ('interactive', 'assistant') AND user_id = ?)
        OR (kind NOT IN ('interactive', 'assistant') AND (repo IS NULL${inRepos}))
      )`,
      params: [scope.username, ...scope.repos],
    };
  }

  /**
   * Token totals per day bucket (`(created_at - since) / 86400000`), summed in
   * SQL — the burn chart never pulls run rows into JS. The CAST is load-bearing:
   * better-sqlite3 binds the ms timestamp as a REAL, which turns the division
   * real too — fractional buckets group per-run and the day lookup drops them.
   */
  usageByDay(since: number, scope: UsageScope): UsageDayRow[] {
    const w = this.usageWhere(scope);
    return this.db
      .prepare(
        `SELECT CAST((created_at - ?) / 86400000 AS INTEGER) AS bucket,
                SUM(input_tokens) AS input, SUM(output_tokens) AS output
         FROM runs WHERE created_at >= ?${w.clause} GROUP BY bucket`,
      )
      .all(since, since, ...w.params) as UsageDayRow[];
  }

  /**
   * Window totals per model — the leaderboard behind the dashboard's cost
   * estimate. Bounded by the distinct models used in the window; same
   * visibility scope as usageByDay.
   */
  usageByModel(since: number, scope: UsageScope): UsageModelRow[] {
    const w = this.usageWhere(scope);
    return this.db
      .prepare(
        `SELECT model, COUNT(*) AS runs,
                SUM(input_tokens) AS input, SUM(output_tokens) AS output
         FROM runs WHERE created_at >= ?${w.clause}
         GROUP BY model ORDER BY SUM(input_tokens) + SUM(output_tokens) DESC`,
      )
      .all(since, ...w.params) as UsageModelRow[];
  }

  /** Boot-time sweep: any run left live-ish died with the daemon. */
  markInterrupted(): number {
    const result = this.db
      .prepare(
        `UPDATE runs SET status = 'interrupted', updated_at = ? WHERE status IN ('running', 'provisioning', 'queued')`,
      )
      .run(Date.now());
    return result.changes;
  }
}

/** Pre-resolved visibility for usage aggregates; null = unrestricted (admin). */
export type UsageScope = { username: string; repos: readonly string[] } | null;

export interface UsageDayRow {
  bucket: number;
  input: number;
  output: number;
}

export interface UsageModelRow {
  model: string | null;
  runs: number;
  input: number;
  output: number;
}

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
  runner_id: string | null;
  user_id: string | null;
  created_at: number;
  updated_at: number;
  input_tokens: number;
  output_tokens: number;
  outcome: string | null;
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
    runnerId: row.runner_id,
    userId: row.user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    live,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    outcome: row.outcome,
  };
}
