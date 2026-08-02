import { safeParse, type Database } from '@moxxy/companion-sdk/server';
import type {
  FindingState,
  FindingVerification,
  PrReviewBudgetProgress,
  PrReviewCoverage,
  PrReviewProgress,
  PrReviewResult,
  PrReviewVerdict,
  ReviewDepth,
  ReviewFinding,
  ReviewStrictness,
} from '../contract/index.js';
import { terminalReviewCoverage } from '../contract/index.js';
import { outcomeSql, toCounts, type OutcomeCounts } from './quality.js';

/** AI PR review verdicts; the latest row per PR wins. */
export class PrReviewsStore {
  constructor(private readonly db: Database) {}

  /** Outcome counts for one workspace's AI reviews since a point in time. */
  outcomes(workspaceId: string, since: number): OutcomeCounts {
    return toCounts(
      this.db.prepare(outcomeSql('pr_reviews')).all(workspaceId, since) as Array<{ status: string; n: number }>,
    );
  }

  insert(r: PrReviewResult): void {
    this.db
      .prepare(
        `INSERT INTO pr_reviews (id, repo, pr_number, run_id, run_ids, source, status, verdict, error, created_at,
                                 head_sha, depth, strictness, progress, coverage)
         VALUES (@id, @repo, @prNumber, @runId, @runIds, @source, @status, @verdict, @error, @createdAt,
                 @headSha, @depth, @strictness, @progress, @coverage)`,
      )
      .run({
        id: r.id,
        repo: r.repo,
        prNumber: r.prNumber,
        // The column is NOT NULL from the original schema and SQLite cannot
        // relax that without rebuilding the table; '' is the stored absence.
        runId: r.runId ?? '',
        runIds: JSON.stringify(r.runIds),
        source: r.source,
        status: r.status,
        verdict: r.verdict ? JSON.stringify(r.verdict) : null,
        error: r.error,
        createdAt: r.createdAt,
        headSha: r.headSha,
        depth: r.depth,
        strictness: r.strictness,
        progress: JSON.stringify(r.progress),
        coverage: JSON.stringify(r.coverage),
      });
  }

  /** Update the aggregate job while its child runs progress. */
  setProgress(id: string, progress: PrReviewProgress, coverage?: PrReviewCoverage): void {
    this.db
      .prepare(
        `UPDATE pr_reviews SET progress = ?, coverage = COALESCE(?, coverage)
         WHERE id = ? AND status = 'running'`,
      )
      .run(JSON.stringify(progress), coverage ? JSON.stringify(coverage) : null, id);
  }

  /**
   * A sibling child can report its final tokens just after another child trips
   * the aggregate ceiling. Preserve the terminal phase/message while folding
   * that late evidence into the durable budget snapshot.
   */
  setBudgetEvidence(id: string, budget: PrReviewBudgetProgress): void {
    const row = this.db.prepare(`SELECT progress, created_at FROM pr_reviews WHERE id = ?`).get(id) as
      | { progress: string | null; created_at: number }
      | undefined;
    if (!row) return;
    const progress = row.progress
      ? safeParse<PrReviewProgress>(row.progress, finishedProgress(row.created_at))
      : finishedProgress(row.created_at);
    this.db
      .prepare(`UPDATE pr_reviews SET progress = ? WHERE id = ?`)
      .run(JSON.stringify({ ...progress, budget }), id);
  }

  /** Attach a child run and make the first one the backwards-compatible link. */
  appendRun(id: string, runId: string): boolean {
    const row = this.db.prepare(`SELECT run_id, run_ids, status FROM pr_reviews WHERE id = ?`).get(id) as
      | { run_id: string; run_ids: string | null; status: PrReviewResult['status'] }
      | undefined;
    if (!row || row.status !== 'running') return false;
    const ids = row.run_ids ? safeParse<string[]>(row.run_ids, []) : [];
    if (!ids.includes(runId)) ids.push(runId);
    return (
      this.db
        .prepare(
          `UPDATE pr_reviews SET run_id = CASE WHEN run_id = '' THEN ? ELSE run_id END, run_ids = ?
           WHERE id = ? AND status = 'running'`,
        )
        .run(runId, JSON.stringify(ids), id).changes > 0
    );
  }

  /** Settle a running aggregate without overwriting another terminal outcome that raced it. */
  finish(r: PrReviewResult): boolean {
    return (
      this.db
        .prepare(
          `UPDATE pr_reviews SET run_id = ?, run_ids = ?, status = ?, verdict = ?, error = ?,
                                 progress = ?, coverage = ?, head_sha = ?, depth = ?, strictness = ?
           WHERE id = ? AND status = 'running'`,
        )
        .run(
          r.runId ?? '',
          JSON.stringify(r.runIds),
          r.status,
          r.verdict ? JSON.stringify(r.verdict) : null,
          r.error,
          JSON.stringify(r.progress),
          JSON.stringify(r.coverage),
          r.headSha,
          r.depth,
          r.strictness,
          r.id,
        ).changes > 0
    );
  }

  /** Atomically stop a running aggregate while leaving its partial coverage/run history intact. */
  terminateRunning(
    id: string,
    status: 'cancelled' | 'failed',
    error: string,
    progress: PrReviewProgress,
    coverage: PrReviewCoverage,
  ): boolean {
    return (
      this.db
        .prepare(
          `UPDATE pr_reviews SET status = ?, error = ?, progress = ?, coverage = ?
           WHERE id = ? AND status = 'running'`,
        )
        .run(status, error, JSON.stringify(progress), JSON.stringify(terminalReviewCoverage(coverage)), id).changes > 0
    );
  }

  /** A daemon restart cannot leave a review looking live forever. */
  failInterrupted(): string[] {
    const rows = this.db
      .prepare(`SELECT id, repo, created_at, progress, coverage FROM pr_reviews WHERE status = 'running'`)
      .all() as Array<{
      id: string;
      repo: string;
      created_at: number;
      progress: string | null;
      coverage: string | null;
    }>;
    const now = Date.now();
    const update = this.db.prepare(
      `UPDATE pr_reviews SET status = 'failed', error = ?, progress = ?, coverage = ?
       WHERE id = ? AND status = 'running'`,
    );
    const failAll = this.db.transaction(() => {
      for (const row of rows) {
        const progress = row.progress
          ? safeParse<PrReviewProgress>(row.progress, finishedProgress(row.created_at))
          : finishedProgress(row.created_at);
        const coverage = row.coverage ? safeParse<PrReviewCoverage>(row.coverage, legacyCoverage) : legacyCoverage;
        update.run(
          'interrupted before the review finished',
          JSON.stringify({
            ...progress,
            phase: 'complete',
            message: 'Interrupted before the review finished',
            updatedAt: now,
          } satisfies PrReviewProgress),
          JSON.stringify(terminalReviewCoverage(coverage)),
          row.id,
        );
      }
    });
    failAll();
    return [...new Set(rows.map((row) => row.repo))];
  }

  update(id: string, status: PrReviewResult['status']): void {
    this.db.prepare(`UPDATE pr_reviews SET status = ? WHERE id = ?`).run(status, id);
  }

  get(id: string): PrReviewResult | undefined {
    const row = this.db.prepare(`SELECT * FROM pr_reviews WHERE id = ?`).get(id) as PrReviewRow | undefined;
    return row ? prReviewRowToResult(row) : undefined;
  }

  /** Every review of a PR, newest first — the task/PR detail review history. */
  listForPr(repo: string, prNumber: number, limit = 20): PrReviewResult[] {
    const rows = this.db
      .prepare(`SELECT * FROM pr_reviews WHERE repo = ? AND pr_number = ? ORDER BY created_at DESC LIMIT ?`)
      .all(repo, prNumber, limit) as PrReviewRow[];
    return rows.map(prReviewRowToResult);
  }

  latest(repo: string, prNumber: number): PrReviewResult | undefined {
    const row = this.db
      .prepare(`SELECT * FROM pr_reviews WHERE repo = ? AND pr_number = ? ORDER BY created_at DESC LIMIT 1`)
      .get(repo, prNumber) as PrReviewRow | undefined;
    return row ? prReviewRowToResult(row) : undefined;
  }

  running(repo: string, prNumber: number): PrReviewResult | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM pr_reviews WHERE repo = ? AND pr_number = ? AND status = 'running'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(repo, prNumber) as PrReviewRow | undefined;
    return row ? prReviewRowToResult(row) : undefined;
  }

  latestByNumber(repo: string, only?: readonly number[]): Map<number, LatestReviewSignal> {
    const numbers = only ? [...new Set(only)] : null;
    if (numbers?.length === 0) return new Map();
    const restricted = numbers ? ` AND t1.pr_number IN (${numbers.map(() => '?').join(', ')})` : '';
    const rows = this.db
      .prepare(
        `SELECT pr_number, status, verdict FROM pr_reviews t1 WHERE repo = ?${restricted}
         AND id = (SELECT id FROM pr_reviews t2
                    WHERE t2.repo = t1.repo AND t2.pr_number = t1.pr_number
                    ORDER BY created_at DESC, id DESC LIMIT 1)`,
      )
      .all(repo, ...(numbers ?? [])) as Array<{
      pr_number: number;
      status: PrReviewResult['status'];
      verdict: string | null;
    }>;
    return new Map(rows.map((r) => [r.pr_number, toSignal(r.status, r.verdict)]));
  }
}

/** The slice of the latest AI review that PR list rows carry. */
export interface LatestReviewSignal {
  readonly status: PrReviewResult['status'];
  readonly risk: NonNullable<PrReviewResult['verdict']>['risk'] | null;
}

export function reviewSignal(review: PrReviewResult | undefined): LatestReviewSignal | null {
  if (!review) return null;
  return { status: review.status, risk: review.verdict?.risk ?? null };
}

function toSignal(status: PrReviewResult['status'], verdict: string | null): LatestReviewSignal {
  const parsed = verdict ? safeParse<PrReviewVerdict | null>(verdict, null) : null;
  return { status, risk: parsed?.risk ?? null };
}

interface PrReviewRow {
  id: string;
  repo: string;
  pr_number: number;
  run_id: string;
  run_ids: string | null;
  source: 'agent' | 'human' | null;
  status: PrReviewResult['status'];
  verdict: string | null;
  error: string | null;
  created_at: number;
  head_sha: string | null;
  depth: ReviewDepth | null;
  strictness: ReviewStrictness | null;
  progress: string | null;
  coverage: string | null;
}

const finishedProgress = (createdAt: number): PrReviewProgress => ({
  phase: 'complete',
  completed: 1,
  total: 1,
  message: 'Review finished',
  updatedAt: createdAt,
});

const legacyCoverage: PrReviewCoverage = {
  state: 'unavailable',
  reviewedGroups: 0,
  totalGroups: 0,
  reviewedFiles: 0,
  totalFiles: 0,
  unread: [],
};

function prReviewRowToResult(row: PrReviewRow): PrReviewResult {
  return {
    id: row.id,
    repo: row.repo,
    prNumber: row.pr_number,
    runId: row.run_id || null,
    runIds: row.run_ids ? safeParse<string[]>(row.run_ids, row.run_id ? [row.run_id] : []) : row.run_id ? [row.run_id] : [],
    source: row.source ?? (row.run_id ? 'agent' : 'human'),
    status: row.status,
    verdict: row.verdict ? safeParse<PrReviewVerdict | null>(row.verdict, null) : null,
    error: row.error,
    progress: row.progress ? safeParse<PrReviewProgress>(row.progress, finishedProgress(row.created_at)) : finishedProgress(row.created_at),
    coverage: row.coverage ? safeParse<PrReviewCoverage>(row.coverage, legacyCoverage) : legacyCoverage,
    createdAt: row.created_at,
    headSha: row.head_sha,
    depth: row.depth ?? 'in-depth',
    strictness: row.strictness ?? 'balanced',
    // Hydrated by the caller that needs them; list payloads leave it empty so
    // one row per PR never becomes one query per PR.
    findings: [],
  };
}

/**
 * Findings of a review, one row each.
 *
 * Separate from the verdict JSON because a finding has its own lifecycle: the
 * reviewer includes or rejects it, the verifier rules on it, and once posted it
 * owns the id of the GitHub comment it became.
 */
export class PrReviewFindingsStore {
  constructor(private readonly db: Database) {}

  insertMany(findings: readonly ReviewFinding[]): void {
    if (findings.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO pr_review_findings (id, review_id, source, file, side, line, start_line, severity, title,
                                       reason, impact, suggestion, suggested_patch, confidence, state,
                                       verification, verification_note, rejection_reason, github_comment_id, created_at)
       VALUES (@id, @reviewId, @source, @file, @side, @line, @startLine, @severity, @title,
               @reason, @impact, @suggestion, @suggestedPatch, @confidence, @state,
               @verification, @verificationNote, @rejectionReason, @githubCommentId, @createdAt)`,
    );
    const insertAll = this.db.transaction((rows: readonly ReviewFinding[]) => {
      for (const f of rows) stmt.run(findingToParams(f));
    });
    insertAll(findings);
  }

  listForReview(reviewId: string): ReviewFinding[] {
    const rows = this.db
      .prepare(`SELECT * FROM pr_review_findings WHERE review_id = ? ORDER BY created_at, id`)
      .all(reviewId) as FindingRow[];
    return rows.map(rowToFinding);
  }

  get(id: string): ReviewFinding | undefined {
    const row = this.db.prepare(`SELECT * FROM pr_review_findings WHERE id = ?`).get(id) as FindingRow | undefined;
    return row ? rowToFinding(row) : undefined;
  }

  /**
   * The finding a GitHub comment came from, for a delivery that names a comment
   * id and nothing else. No match means the thread is somebody else's.
   */
  findingByGithubCommentId(githubCommentId: number): ReviewFinding | undefined {
    const row = this.db
      .prepare(`SELECT * FROM pr_review_findings WHERE github_comment_id = ?`)
      .get(githubCommentId) as FindingRow | undefined;
    return row ? rowToFinding(row) : undefined;
  }

  setState(id: string, state: FindingState, rejectionReason?: string | null): void {
    this.db
      .prepare(`UPDATE pr_review_findings SET state = ?, rejection_reason = ? WHERE id = ?`)
      .run(state, rejectionReason ?? null, id);
  }

  /**
   * Dismissing a whole review rejects what it proposed, so nothing stays armed.
   *
   * No reason is written: a bulk dismissal is not a judgement about any one
   * finding, and recording it as one would feed noise into the calibration
   * below, which exists to learn from what a human actually argued.
   */
  rejectOpen(reviewId: string): void {
    this.db
      .prepare(
        `UPDATE pr_review_findings SET state = 'rejected'
         WHERE review_id = ? AND state IN ('proposed', 'included')`,
      )
      .run(reviewId);
  }

  /**
   * What this repository's reviewers have argued is not worth raising.
   *
   * Only findings a human took the trouble to reject WITH a written reason
   * count. An unticked checkbox says nothing about why, and treating silence
   * as an argument is how a tool teaches itself to stop reporting real things.
   *
   * Deliberately limited to minor/nit severities. A team that once waved a
   * blocker through — out of hurry, not conviction — must not thereby train the
   * reviewer to stop mentioning that class of defect.
   */
  recentRejections(repo: string, limit = 15): Array<{ title: string; reason: string }> {
    return this.db
      .prepare(
        `SELECT f.title AS title, f.rejection_reason AS reason
           FROM pr_review_findings f
           JOIN pr_reviews r ON r.id = f.review_id
          WHERE r.repo = ?
            AND f.state = 'rejected'
            AND f.severity IN ('minor', 'nit')
            AND f.rejection_reason IS NOT NULL
            AND TRIM(f.rejection_reason) != ''
          ORDER BY f.created_at DESC
          LIMIT ?`,
      )
      .all(repo, limit) as Array<{ title: string; reason: string }>;
  }

  /**
   * Move a person's own comments onto another review.
   *
   * Used when an agent review starts while a manual draft is open: the agent's
   * findings supersede any earlier agent findings, but what the reviewer wrote
   * themselves is theirs and must not be orphaned on a superseded row.
   */
  adoptHumanFindings(fromReviewId: string, toReviewId: string): void {
    this.db
      .prepare(
        `UPDATE pr_review_findings SET review_id = ?
         WHERE review_id = ? AND source = 'human' AND state IN ('proposed', 'included')`,
      )
      .run(toReviewId, fromReviewId);
  }

  setVerification(id: string, verification: FindingVerification, note: string | null): void {
    this.db
      .prepare(`UPDATE pr_review_findings SET verification = ?, verification_note = ? WHERE id = ?`)
      .run(verification, note, id);
  }

  markPosted(id: string, githubCommentId: number | null): void {
    this.db
      .prepare(`UPDATE pr_review_findings SET state = 'posted', github_comment_id = ? WHERE id = ?`)
      .run(githubCommentId, id);
  }

  /** Reviewer edits to the text that will be posted. */
  updateText(id: string, patch: { reason?: string; suggestion?: string; severity?: string }): void {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (patch.reason !== undefined) (sets.push('reason = ?'), args.push(patch.reason));
    if (patch.suggestion !== undefined) (sets.push('suggestion = ?'), args.push(patch.suggestion));
    if (patch.severity !== undefined) (sets.push('severity = ?'), args.push(patch.severity));
    if (sets.length === 0) return;
    args.push(id);
    this.db.prepare(`UPDATE pr_review_findings SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  }
}

interface FindingRow {
  id: string;
  review_id: string;
  source: string;
  file: string | null;
  side: 'LEFT' | 'RIGHT' | null;
  line: number | null;
  start_line: number | null;
  severity: ReviewFinding['severity'];
  title: string;
  reason: string;
  impact: string;
  suggestion: string;
  suggested_patch: string | null;
  confidence: number;
  state: FindingState;
  verification: FindingVerification;
  verification_note: string | null;
  rejection_reason: string | null;
  github_comment_id: number | null;
  created_at: number;
}

function findingToParams(f: ReviewFinding): Record<string, unknown> {
  return {
    id: f.id,
    reviewId: f.reviewId,
    source: f.source,
    file: f.anchor?.file ?? null,
    side: f.anchor?.side ?? null,
    line: f.anchor?.line ?? null,
    startLine: f.anchor?.startLine ?? null,
    severity: f.severity,
    title: f.title,
    reason: f.reason,
    impact: f.impact,
    suggestion: f.suggestion,
    suggestedPatch: f.suggestedPatch,
    confidence: f.confidence,
    state: f.state,
    verification: f.verification,
    verificationNote: f.verificationNote,
    rejectionReason: f.rejectionReason,
    githubCommentId: f.githubCommentId,
    createdAt: f.createdAt,
  };
}

function rowToFinding(row: FindingRow): ReviewFinding {
  return {
    id: row.id,
    reviewId: row.review_id,
    source: row.source,
    anchor:
      row.file !== null && row.side !== null && row.line !== null
        ? { file: row.file, side: row.side, line: row.line, startLine: row.start_line }
        : null,
    severity: row.severity,
    title: row.title,
    reason: row.reason,
    impact: row.impact,
    suggestion: row.suggestion,
    suggestedPatch: row.suggested_patch,
    confidence: row.confidence,
    state: row.state,
    verification: row.verification,
    verificationNote: row.verification_note,
    rejectionReason: row.rejection_reason,
    githubCommentId: row.github_comment_id,
    createdAt: row.created_at,
  };
}
