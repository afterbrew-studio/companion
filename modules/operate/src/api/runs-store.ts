import type { Database } from '@moxxy/companion-services';
import type { AgentStorageRunLease } from '@moxxy/companion-types';
import { likeArg, safeParse } from '@moxxy/companion-services';
import type { RunKind, RunListRecord, RunRecord, RunStatus, RunVerification } from '../contract/index.js';
import { describeHarness } from './harnesses.js';
import { LOCAL_RUNNER_ID } from './runners-store.js';

/** Agent runs — rows are the source of truth; gateway processes are cattle. */
export class RunsStore {
  constructor(private readonly db: Database) {}

  /** `harness` is the id, not the descriptor: the row stores the choice, and
   *  what that harness can do is read back from the build that implements it. */
  insert(run: Omit<RunRecord, 'live' | 'harness'> & { readonly harness: string }): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, kind, status, title, cwd, repo, issue_number, proposal_id, branch, pr_url, model, runner_id, user_id, task, harness, created_at, updated_at, input_tokens, output_tokens, outcome)
         VALUES (@id, @kind, @status, @title, @cwd, @repo, @issueNumber, @proposalId, @branch, @prUrl, @model, @runnerId, @userId, @task, @harness, @createdAt, @updatedAt, @inputTokens, @outputTokens, @outcome)`,
      )
      // Named one by one rather than handed the whole record: a key the SQL does
      // not declare is an error now, not a silent drop, and `verification` is set
      // by its own statement after the row exists.
      .run({
        id: run.id,
        kind: run.kind,
        status: run.status,
        title: run.title,
        cwd: run.cwd,
        repo: run.repo,
        issueNumber: run.issueNumber,
        proposalId: run.proposalId,
        branch: run.branch,
        prUrl: run.prUrl,
        model: run.model,
        runnerId: run.runnerId,
        userId: run.userId,
        task: run.task,
        harness: run.harness,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        outcome: run.outcome,
      });
  }

  /**
   * Set the run's cwd + runner after placement (before the gateway spawns).
   * The harness moves with the machine: which runtime a run executes through is
   * the machine's choice, so failing over to another one changes it.
   */
  setPlacement(id: string, runnerId: string | null, cwd: string, harness: string): void {
    this.db
      .prepare(`UPDATE runs SET runner_id = ?, cwd = ?, harness = ?, updated_at = ? WHERE id = ?`)
      .run(runnerId, cwd, harness, Date.now(), id);
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

  setVerification(id: string, verification: RunVerification): void {
    this.db
      .prepare(`UPDATE runs SET verification = ?, updated_at = ? WHERE id = ?`)
      .run(JSON.stringify(verification), Date.now(), id);
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

  listPage(opts: {
    readonly userId: string;
    readonly repoNames?: readonly string[];
    readonly q?: string;
    readonly repo?: string;
    readonly kind?: RunKind;
    readonly status?: 'active' | 'review' | 'running' | 'completed' | 'failed' | 'stopped';
    readonly limit?: number;
    readonly offset?: number;
  }): { rows: RunListRow[]; total: number } {
    const where = [
      `(((kind IN ('interactive', 'assistant') OR repo IS NOT NULL) AND user_id = ?)
         OR (kind NOT IN ('interactive', 'assistant') AND repo IS NULL))`,
    ];
    const args: unknown[] = [opts.userId];
    if (opts.repoNames) {
      where.push(
        opts.repoNames.length > 0
          ? `(repo IS NULL OR repo IN (${opts.repoNames.map(() => '?').join(', ')}))`
          : 'repo IS NULL',
      );
      args.push(...opts.repoNames);
    }
    if (opts.q) {
      const like = likeArg(opts.q);
      where.push(`(title LIKE ? ESCAPE '\\' OR COALESCE(repo, '') LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')`);
      args.push(like, like, like);
    }
    if (opts.repo) {
      where.push('repo = ?');
      args.push(opts.repo);
    }
    if (opts.kind) {
      where.push('kind = ?');
      args.push(opts.kind);
    }
    if (opts.status === 'active') {
      where.push(`status IN ('provisioning', 'running', 'idle', 'review')`);
    } else if (opts.status === 'failed') {
      where.push(`status IN ('failed', 'interrupted')`);
    } else if (opts.status === 'stopped') {
      where.push(`status IN ('stopped', 'abandoned')`);
    } else if (opts.status) {
      where.push('status = ?');
      args.push(opts.status);
    }
    const clause = `WHERE ${where.join(' AND ')}`;
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM runs ${clause}`).get(...args) as { n: number }).n;
    const limit = Math.min(Math.max(Number.isSafeInteger(opts.limit) ? opts.limit! : 50, 1), 100);
    const offset = Math.min(Math.max(Number.isSafeInteger(opts.offset) ? opts.offset! : 0, 0), 1_000_000);
    const rows = this.db
      .prepare(
        `SELECT id, kind, status, title, repo, issue_number, proposal_id, branch, pr_url, model,
                runner_id, user_id, task, harness, created_at, updated_at, input_tokens, output_tokens
         FROM runs ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset) as RunListRow[];
    return { rows, total };
  }

  /** Bounded runner artifact lease set: active/review rows are always included;
   * recent terminal rows carry their logical last-use time into filesystem
   * retention. Older rows can be treated as unleased stale artifacts. */
  storageLeasesForRunner(runnerId: string | null, since: number): AgentStorageRunLease[] {
    const rows = this.db
      .prepare(
        `SELECT id, cwd, status, updated_at FROM runs
         WHERE runner_id IS ?
           AND (updated_at >= ? OR status IN ('provisioning', 'running', 'idle', 'review'))`,
      )
      .all(runnerId, since) as Array<Pick<RunRow, 'id' | 'cwd' | 'status' | 'updated_at'>>;
    return rows.map((row) => ({
      runId: row.id,
      cwd: row.cwd,
      updatedAt: row.updated_at,
      protected: row.status === 'provisioning' || row.status === 'running' || row.status === 'idle' || row.status === 'review',
    }));
  }

  /**
   * Non-terminal run counts per runner (key: runner_id, null = local). Used by
   * placement so a batch spreads across runners by the runs already assigned to
   * each — not just the gateways that have actually spawned yet.
   */
  /**
   * What actually ran each task last, and on what.
   *
   * A settings page can state what a task WOULD use, but only the run rows say
   * what it DID: a pin can be dropped at dispatch and a lane can send work
   * somewhere else, and neither is visible from the settings alone.
   */
  lastByTask(): Map<string, { harness: string; model: string | null; at: number }> {
    // SQLite's bare-column-with-MAX form: one grouped pass, and the other
    // columns come from the row that MAX picked. The correlated subquery this
    // replaces was evaluated once per candidate row against a table with no
    // index on `task` and one that only grows, so it was quadratic — and the
    // settings page that calls it refetches on two broadcasts.
    const rows = this.db
      .prepare(
        `SELECT task, harness, model, MAX(created_at) AS created_at FROM runs
          WHERE task IS NOT NULL
          GROUP BY task`,
      )
      .all() as Array<{ task: string; harness: string; model: string | null; created_at: number }>;
    return new Map(rows.map((r) => [r.task, { harness: r.harness, model: r.model, at: r.created_at }]));
  }

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
   * Runs currently executing (or about to) on a specific runner — the set a
   * dead runner strands. `review` rows are excluded: their gateway may be gone
   * but the finished diff is worth keeping visible until someone acts on it.
   */
  activeOnRunner(runnerId: string): RunRow[] {
    return this.db
      .prepare(
        `SELECT * FROM runs WHERE runner_id = ? AND status IN ('provisioning', 'running', 'idle')`,
      )
      .all(runnerId) as RunRow[];
  }

  /**
   * Live attended chats (interactive + AI Help) holding a slot of the pool the
   * given user schedules against: shared runners (runner_id null = local) plus
   * the user's own machines. A colleague's chats parked on THEIR personal
   * runner must not eat this user's headroom — the capacities don't overlap.
   * With `runnerIds`, only chats on those machines count — the gate compares
   * against task-filtered capacity, so a chat parked on a runner outside that
   * pool must not eat the pool's headroom. The caller passes the ids whose
   * task policy accepts the task (null = no task filter), so the policy has
   * one definition instead of a second one written in SQL. Local chats ALWAYS
   * count: the local runner is the last-resort sink (placement and the
   * assistant's no-public-url pin can park chats there past its policy), and a
   * gate blind to them would admit chats without bound.
   */
  activeInteractiveCount(userId: string | null = null, runnerIds: readonly string[] | null = null): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM runs r
           JOIN runners k ON k.id = COALESCE(r.runner_id, @local)
           WHERE r.kind IN ('interactive', 'assistant')
             AND r.status IN ('provisioning', 'running', 'idle', 'review')
             AND (k.owner_id IS NULL OR k.owner_id = @userId)
             AND (@ids IS NULL OR r.runner_id IS NULL OR EXISTS (
               SELECT 1 FROM json_each(@ids) WHERE value = k.id))`,
        )
        .get({ userId, ids: runnerIds === null ? null : JSON.stringify(runnerIds), local: LOCAL_RUNNER_ID }) as {
        n: number;
      }
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
   * own attended chats, repo-less automated runs, and repo work explicitly
   * authorized by that same profile's personal GitHub account.
   */
  private usageWhere(scope: UsageScope): { clause: string; params: Array<string | number> } {
    return {
      clause: ` AND (
        (kind IN ('interactive', 'assistant') AND user_id = ?)
        OR (kind NOT IN ('interactive', 'assistant') AND (repo IS NULL OR user_id = ?))
      )`,
      params: [scope.username, scope.username],
    };
  }

  /**
   * Token totals per day bucket (`(created_at - since) / 86400000`), summed in
   * SQL — the burn chart never pulls run rows into JS. The CAST is load-bearing:
   * node:sqlite binds the ms timestamp as a REAL, which turns the division real
   * too, so fractional buckets group per-run and the day lookup drops them.
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

  /**
   * Spend inputs for the budget gate: the WHOLE instance's totals per model,
   * or one profile's. Deliberately NOT viewer-scoped like `usageByModel` — a
   * ceiling that only counted the runs you happen to be allowed to look at
   * would not be a ceiling. Never reaches a route directly; only the priced
   * aggregate does.
   */
  spendByModel(since: number, userId?: string): UsageModelRow[] {
    const clause = userId === undefined ? '' : ' AND user_id = ?';
    const params = userId === undefined ? [since] : [since, userId];
    return this.db
      .prepare(
        `SELECT model, COUNT(*) AS runs, SUM(input_tokens) AS input, SUM(output_tokens) AS output
         FROM runs WHERE created_at >= ?${clause} GROUP BY model`,
      )
      .all(...params) as UsageModelRow[];
  }

  /**
   * Spend grouped by an attribution dimension AND model, because price is a
   * property of the model: bucketing first and pricing after would average a
   * Haiku run and an Opus run into a number that is neither. The column is
   * chosen from a fixed map, never interpolated from caller input.
   */
  spendByDimension(dimension: SpendDimension, since: number): SpendGroupRow[] {
    const column = SPEND_COLUMNS[dimension];
    return this.db
      .prepare(
        `SELECT ${column} AS key, model, COUNT(*) AS runs,
                SUM(input_tokens) AS input, SUM(output_tokens) AS output
         FROM runs WHERE created_at >= ? GROUP BY ${column}, model`,
      )
      .all(since) as SpendGroupRow[];
  }

  /**
   * Boot-time sweep: a verification that was in flight when the daemon stopped.
   *
   * It cannot be resumed (the child is gone) and it must not stay 'running',
   * because a consumer waiting for it to settle would wait forever. 'unavailable'
   * is the honest answer and the one that unblocks: we did not check.
   */
  failInterruptedVerifications(): number {
    return this.db
      .prepare(
        `UPDATE runs
         SET verification = json_set(
               json_set(verification, '$.status', 'unavailable'),
               '$.output', 'the daemon restarted before verification finished'
             )
         WHERE verification IS NOT NULL AND json_extract(verification, '$.status') = 'running'`,
      )
      .run().changes;
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

/** Pre-resolved visibility for usage aggregates. */
export type UsageScope = { username: string };

/** The dimensions spend can be attributed along. */
export type SpendDimension = 'user' | 'task' | 'repo';

const SPEND_COLUMNS: Record<SpendDimension, string> = {
  user: 'user_id',
  task: 'task',
  repo: 'repo',
};

export interface SpendGroupRow {
  key: string | null;
  model: string | null;
  runs: number;
  input: number;
  output: number;
}

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
  task: string | null;
  /** Harness id this run executes through; 'moxxy' on rows that predate it. */
  harness: string;
  verification: string | null;
  created_at: number;
  updated_at: number;
  input_tokens: number;
  output_tokens: number;
  outcome: string | null;
}

export type RunListRow = Omit<RunRow, 'cwd' | 'verification' | 'outcome'>;

export function rowToRunList(row: RunListRow, live: boolean): RunListRecord {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    title: row.title,
    repo: row.repo,
    issueNumber: row.issue_number,
    proposalId: row.proposal_id,
    branch: row.branch,
    prUrl: row.pr_url,
    model: row.model,
    runnerId: row.runner_id,
    harness: describeHarness(row.harness),
    userId: row.user_id,
    task: row.task,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    live,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
  };
}

export function rowToRun(row: RunRow, live: boolean): RunRecord {
  return {
    ...rowToRunList(row, live),
    cwd: row.cwd,
    verification: row.verification ? (safeParse<RunVerification | null>(row.verification, null)) : null,
    outcome: row.outcome,
  };
}
