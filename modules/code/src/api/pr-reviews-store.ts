import { safeParse, type Database } from '@moxxy/companion-sdk/server';
import type {
  FindingState,
  FindingVerification,
  PrReviewResult,
  PrReviewVerdict,
  ReviewDepth,
  ReviewFinding,
  ReviewStrictness,
} from '../contract/index.js';
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
        `INSERT INTO pr_reviews (id, repo, pr_number, run_id, status, verdict, error, created_at,
                                 head_sha, depth, strictness)
         VALUES (@id, @repo, @prNumber, @runId, @status, @verdict, @error, @createdAt,
                 @headSha, @depth, @strictness)`,
      )
      .run({
        id: r.id,
        repo: r.repo,
        prNumber: r.prNumber,
        // The column is NOT NULL from the original schema and SQLite cannot
        // relax that without rebuilding the table; '' is the stored absence.
        runId: r.runId ?? '',
        status: r.status,
        verdict: r.verdict ? JSON.stringify(r.verdict) : null,
        error: r.error,
        createdAt: r.createdAt,
        headSha: r.headSha,
        depth: r.depth,
        strictness: r.strictness,
      });
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

  latestByNumber(repo: string): Map<number, LatestReviewSignal> {
    const rows = this.db
      .prepare(
        `SELECT pr_number, status, verdict FROM pr_reviews t1 WHERE repo = ?
         AND created_at = (SELECT MAX(created_at) FROM pr_reviews t2 WHERE t2.repo = t1.repo AND t2.pr_number = t1.pr_number)`,
      )
      .all(repo) as Array<{ pr_number: number; status: PrReviewResult['status']; verdict: string | null }>;
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
  status: PrReviewResult['status'];
  verdict: string | null;
  error: string | null;
  created_at: number;
  head_sha: string | null;
  depth: ReviewDepth | null;
  strictness: ReviewStrictness | null;
}

function prReviewRowToResult(row: PrReviewRow): PrReviewResult {
  return {
    id: row.id,
    repo: row.repo,
    prNumber: row.pr_number,
    runId: row.run_id || null,
    status: row.status,
    verdict: row.verdict ? safeParse<PrReviewVerdict | null>(row.verdict, null) : null,
    error: row.error,
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
