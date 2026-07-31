import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SpaServerMessage } from '@moxxy/companion-contracts';
import type {
  FindingSeverity,
  PrReviewResult,
  PrReviewVerdict,
  ReviewDepth,
  ReviewFinding,
  ReviewOptions,
  ReviewPostMode,
  ReviewStrictness,
} from '../contract/index.js';
import { buildAnchorIndex, checkAnchor, unifiedDiffFromPatches } from '../contract/diff-anchors.js';
import { meetsStrictness } from '../contract/index.js';
import { log } from '@moxxy/companion-sdk/server';
import { extractModelJson } from '@moxxy/companion-sdk/agents';
import type { CodeStore } from './code-store.js';
import type { OutcomeCounts } from './quality.js';
import type { Orchestrator, Checkouts } from './operate-types.js';
import { GitHubError, type GhReviewCommentInput, type GitHubClient } from './github-client.js';
import { describeChecks, type PrChecks } from './pr-checks.js';
import {
  reviewCommentTrigger,
  underReplyCap,
  type ReviewCommentPayload,
  type ReviewCommentTrigger,
} from './review-replies.js';

/**
 * One finding as the model reports it. `quotedLine` never reaches storage: it
 * exists so the anchor can be checked against what the diff actually says,
 * which is the cheapest test for a line number that was invented.
 */
const modelFindingSchema = z.object({
  title: z.string().min(1).max(200),
  severity: z.enum(['blocker', 'major', 'minor', 'nit']),
  file: z.string().max(400).nullish(),
  side: z.enum(['LEFT', 'RIGHT']).nullish(),
  line: z.number().int().positive().nullish(),
  startLine: z.number().int().positive().nullish(),
  quotedLine: z.string().max(2000).nullish(),
  reason: z.string().max(4000).default(''),
  impact: z.string().max(2000).default(''),
  suggestion: z.string().max(4000).default(''),
  suggestedPatch: z.string().max(8000).nullish(),
  confidence: z.number().min(0).max(1).default(0.5),
});

/**
 * `findings` accepts both shapes: the anchored objects this asks for, and the
 * bare strings the prompt used to return. Rejecting the old shape would turn a
 * model that fell back to it into a failed review rather than a shallow one.
 */
const verdictSchema = z.object({
  summary: z.string(),
  risk: z.enum(['low', 'medium', 'high']),
  recommendation: z.enum(['approve', 'request_changes', 'comment']),
  findings: z.array(z.union([modelFindingSchema, z.string()])).max(40).default([]),
  reviewBody: z.string(),
});

type ModelFinding = z.infer<typeof modelFindingSchema>;

/** Verification is only worth its cost above this bar, plus anything shaky. */
const VERIFY_SEVERITIES: ReadonlySet<FindingSeverity> = new Set<FindingSeverity>(['blocker', 'major']);
const VERIFY_CONFIDENCE_FLOOR = 0.6;
/** Concurrent verifier runs sharing one worktree. */
const VERIFY_CONCURRENCY = 3;
/** Inline comments per posted review; the rest travel in the body. */
const MAX_INLINE_COMMENTS = 25;

/**
 * Wall clock for one review turn. When it expires the run is stopped mid-turn
 * and everything it had done is lost, so this is deliberately generous: a
 * review that takes too long is cheaper to wait for than to repeat.
 *
 * Measured against real pull requests, not derived: an in-depth pass over a
 * few hundred changed lines spent over twenty minutes reading before it began
 * writing its verdict.
 */
function reviewTimeoutMs(depth: ReviewDepth): number {
  return (depth === 'in-depth' ? 45 : 15) * 60_000;
}

/**
 * PR reviews, review-then-apply like triage: an agent reads the PR diff
 * against the repo checkout and returns a structured verdict; posting the
 * review / merging / closing only happens on explicit human action — except
 * when the repo's PR gate auto-posts a confident verdict (see Automations).
 */
export class PrReviews {
  constructor(
    private readonly store: CodeStore,
    private readonly orchestrator: Orchestrator,
    private readonly checkouts: Checkouts,
    private readonly github: (ctx?: { repo?: string; accountId?: string; username?: string | null }) => GitHubClient | null,
    private readonly mergeGithub: (
      repo: string,
      prNumber: number,
      method: 'merge' | 'squash' | 'rebase',
      ctx?: { accountId?: string; username?: string | null },
    ) => Promise<{
      result: { merged: boolean; message: string } | null;
      client: GitHubClient | null;
      tried: string[];
    }>,
    private readonly checks: PrChecks,
    private readonly broadcast: (msg: SpaServerMessage) => void,
  ) {}

  /** Outcome counts for the quality report; the store owns the aggregate. */
  outcomes(workspaceId: string, since: number): OutcomeCounts {
    return this.store.prReviews.outcomes(workspaceId, since);
  }

  async analyzePr(repo: string, prNumber: number, userId: string, opts?: ReviewOptions): Promise<PrReviewResult> {
    const pr = this.store.prs.get(repo, prNumber);
    if (!pr) throw new Error(`unknown PR ${repo}#${prNumber}`);
    if (!this.github({ repo, username: userId })) throw new Error('GitHub is not configured');
    if (!this.checkouts.hasClone(repo)) throw new Error(`repo ${repo} has no clone yet`);

    const depth: ReviewDepth = opts?.depth ?? 'in-depth';
    const strictness: ReviewStrictness = opts?.strictness ?? 'balanced';
    // Verification pays for itself when the agent went line by line; on a
    // high-level pass there are no anchored claims for a verifier to reproduce.
    const verify = opts?.verify ?? depth === 'in-depth';
    const reviewId = `prr-${randomUUID().slice(0, 12)}`;

    const checksSummary = await this.checks.trySummary(repo, prNumber, userId);
    // Everything that needs the checkout happens inside ONE worktree: the
    // review, then the verifiers. Taking a worktree per verifier would re-clone
    // the pull request for each finding.
    const outcome = await this.checkouts.withPullRequestWorktree(
      repo,
      `pr-review-${prNumber}-${randomUUID().slice(0, 8)}`,
      prNumber,
      pr.baseRef,
      async (cwd) => {
        const { runId, finalMessage } = await this.orchestrator.runOneShot({
          kind: 'analysis',
          task: 'code.pr-review',
          title: `Review PR #${prNumber}: ${pr.title.slice(0, 60)}`,
          cwd,
          repo,
          userId,
          issueNumber: prNumber,
          prompt: reviewPrompt({
            title: pr.title,
            body: pr.body,
            author: pr.author,
            baseRef: pr.baseRef,
            checks: describeChecks(checksSummary),
            depth,
            strictness,
            dismissed: this.store.prReviewFindings.recentRejections(repo),
            context: opts?.context,
          }),
          timeoutMs: reviewTimeoutMs(depth),
          // The caller's context rides along so a resumed review keeps its briefing.
          resume: {
            type: 'pr-review',
            args: {
              repo,
              number: prNumber,
              userId,
              depth,
              strictness,
              verify,
              ...(opts?.context ? { context: opts.context } : {}),
            },
          },
        });

        let verdict: PrReviewVerdict | null = null;
        let error: string | null = null;
        let findings: ReviewFinding[] = [];
        // No final message at all means the turn never finished — almost always
        // the ceiling below. Reporting that as a parse failure sends whoever
        // reads it looking for a malformed verdict that was never produced.
        if (!finalMessage?.trim()) {
          const minutes = Math.round(reviewTimeoutMs(depth) / 60_000);
          return {
            runId,
            verdict: null,
            error: `the review did not finish within ${minutes} minutes and was stopped — try a high-level review, or raise the ceiling`,
            findings: [],
          };
        }
        try {
          const parsed = parseVerdictWithFindings(finalMessage);
          // The local diff is free and merge-base scoped exactly like GitHub's,
          // so hallucinated anchors are dropped here rather than at publish
          // time. GitHub's own patches are still the authority when posting.
          const diff = await this.checkouts.diffVsBase(cwd, pr.baseRef).catch(() => '');
          findings = toFindings(reviewId, parsed.findings, diff ? buildAnchorIndex(diff) : null, strictness);
          verdict = { ...parsed, findings: findings.map((f) => f.title) };
        } catch (err) {
          error = `could not parse review verdict: ${String(err)}`;
          log.warn('pr review parse failed', { repo, prNumber, err: String(err) });
        }

        if (verify && findings.length > 0) {
          findings = await this.verifyFindings(cwd, repo, prNumber, userId, pr.baseRef, findings);
        }
        return { runId, verdict, error, findings };
      },
      undefined,
      userId,
    );

    const result: PrReviewResult = {
      id: reviewId,
      repo,
      prNumber,
      runId: outcome.runId,
      status: outcome.verdict ? 'pending' : 'failed',
      verdict: outcome.verdict,
      error: outcome.error,
      createdAt: Date.now(),
      headSha: pr.headSha,
      depth,
      strictness,
      findings: outcome.findings,
    };
    // A draft the reviewer already started stays open otherwise, invisible
    // behind this newer review and taking their comments with it.
    const superseded = this.store.prReviews.latest(repo, prNumber);
    this.store.prReviews.insert(result);
    this.store.prReviewFindings.insertMany(outcome.findings);
    if (superseded?.status === 'pending') {
      this.store.prReviewFindings.adoptHumanFindings(superseded.id, result.id);
      this.store.prReviews.update(superseded.id, 'dismissed');
      this.store.prReviewFindings.rejectOpen(superseded.id);
    }
    this.broadcast({ t: 'prs.changed', repo });
    return { ...result, findings: this.store.prReviewFindings.listForReview(result.id) };
  }

  /**
   * Adversarially re-examine findings in a FRESH session each.
   *
   * The verifier never sees the reviewing agent's reasoning: handed its own
   * argument, a model agrees with itself almost always, and the pass becomes
   * theatre. It gets the claim, the anchor, and the checkout, and is told to
   * refute.
   */
  private async verifyFindings(
    cwd: string,
    repo: string,
    prNumber: number,
    userId: string,
    baseRef: string,
    findings: readonly ReviewFinding[],
  ): Promise<ReviewFinding[]> {
    const worth = (f: ReviewFinding): boolean =>
      VERIFY_SEVERITIES.has(f.severity) || f.confidence < VERIFY_CONFIDENCE_FLOOR;
    const verdicts = new Map<string, { verification: ReviewFinding['verification']; note: string | null }>();
    const queue = findings.filter(worth);

    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < queue.length) {
        const finding = queue[cursor++]!;
        try {
          const { finalMessage } = await this.orchestrator.runOneShot({
            kind: 'analysis',
            task: 'code.review-verify',
            title: `Verify: ${finding.title.slice(0, 60)}`,
            cwd,
            repo,
            userId,
            issueNumber: prNumber,
            prompt: verifyPrompt(finding, baseRef),
            timeoutMs: 6 * 60_000,
          });
          const parsed = verificationSchema.parse(extractModelJson(finalMessage ?? ''));
          verdicts.set(finding.id, {
            verification: parsed.refuted ? 'refuted' : 'confirmed',
            note: parsed.reason.slice(0, 2000),
          });
        } catch (err) {
          // An unverifiable finding stays unverified. Treating a failed
          // verifier as a refutation would silently delete real findings
          // whenever the harness hiccups.
          log.warn('finding verification failed', { repo, prNumber, finding: finding.id, err: String(err) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(VERIFY_CONCURRENCY, queue.length) }, worker));

    return findings.map((f) => {
      const v = verdicts.get(f.id);
      if (!v) return f;
      // A refuted finding is kept but disarmed; the reviewer can still see it.
      return {
        ...f,
        verification: v.verification,
        verificationNote: v.note,
        state: v.verification === 'refuted' ? 'proposed' : f.state,
      };
    });
  }

  /** Review history of a PR, newest first (for detail views, e.g. board tasks). */
  listForPr(repo: string, prNumber: number): PrReviewResult[] {
    return this.store.prReviews.listForPr(repo, prNumber);
  }

  /** One review with its findings hydrated — the PR detail view's payload. */
  getWithFindings(id: string): PrReviewResult | undefined {
    const review = this.store.prReviews.get(id);
    if (!review) return undefined;
    return { ...review, findings: this.store.prReviewFindings.listForReview(id) };
  }

  latestWithFindings(repo: string, prNumber: number): PrReviewResult | null {
    const review = this.store.prReviews.latest(repo, prNumber);
    if (!review) return null;
    return { ...review, findings: this.store.prReviewFindings.listForReview(review.id) };
  }

  /**
   * An empty draft review a person starts themselves.
   *
   * Wanting to leave an inline comment must not require running an agent first.
   * The draft is the same row as an agent's review, minus the run: everything
   * downstream (selection, publishing, the single GitHub review) is one path,
   * and `runId === null` is the only thing that tells them apart.
   */
  createManualReview(repo: string, prNumber: number): PrReviewResult {
    const pr = this.store.prs.get(repo, prNumber);
    if (!pr) throw new Error(`unknown PR ${repo}#${prNumber}`);
    const existing = this.store.prReviews.latest(repo, prNumber);
    if (existing?.status === 'pending') {
      return { ...existing, findings: this.store.prReviewFindings.listForReview(existing.id) };
    }
    const result: PrReviewResult = {
      id: `prr-${randomUUID().slice(0, 12)}`,
      repo,
      prNumber,
      runId: null,
      status: 'pending',
      // A verdict shell so publishing has a body to compose into; the risk and
      // recommendation fields are never shown for a manual draft.
      verdict: { summary: '', risk: 'low', recommendation: 'comment', findings: [], reviewBody: '' },
      error: null,
      createdAt: Date.now(),
      headSha: pr.headSha,
      depth: 'in-depth',
      strictness: 'balanced',
      findings: [],
    };
    this.store.prReviews.insert(result);
    this.broadcast({ t: 'prs.changed', repo });
    return result;
  }

  /**
   * A comment the REVIEWER wrote, on a line they chose, joining the same draft.
   *
   * It is stored as a finding with `source: 'human'` so it travels the whole
   * rest of the way — selection, publishing, the single GitHub review — through
   * exactly one path. A second mechanism for "the same thing but typed by a
   * person" is how the two drift apart.
   */
  async addFinding(
    reviewId: string,
    input: {
      file: string;
      side: 'LEFT' | 'RIGHT';
      line: number;
      startLine?: number | null;
      body: string;
      severity?: FindingSeverity;
    },
    userId: string,
  ): Promise<ReviewFinding> {
    const review = this.store.prReviews.get(reviewId);
    if (!review) throw new Error('review not found');
    if (review.status !== 'pending') throw new Error(`review is ${review.status}, not pending`);
    const client = this.github({ repo: review.repo, username: userId });
    if (!client) throw new Error('GitHub is not configured');

    const { files } = await client.prFiles(review.repo, review.prNumber);
    const anchor = {
      file: input.file,
      side: input.side,
      line: input.line,
      startLine: input.startLine ?? null,
    };
    const problem = checkAnchor(buildAnchorIndex(unifiedDiffFromPatches(files)), anchor);
    // Refused rather than silently demoted to the summary: the reviewer picked
    // this line, and a comment that quietly moves elsewhere is worse than one
    // that says it cannot go there.
    if (problem) throw new Error(`that line is not part of this pull request's diff (${problem})`);

    const body = input.body.trim();
    const finding: ReviewFinding = {
      id: `prf-${randomUUID().slice(0, 12)}`,
      reviewId,
      source: 'human',
      anchor,
      severity: input.severity ?? 'major',
      title: body.split('\n')[0]!.slice(0, 120),
      reason: body,
      impact: '',
      suggestion: '',
      suggestedPatch: null,
      confidence: 1,
      // The reviewer wrote it, so they mean it.
      state: 'included',
      verification: 'unverified',
      verificationNote: null,
      rejectionReason: null,
      githubCommentId: null,
      createdAt: Date.now(),
    };
    this.store.prReviewFindings.insertMany([finding]);
    this.broadcast({ t: 'prs.changed', repo: review.repo });
    return finding;
  }

  /** Reviewer's call on one finding: arm it, drop it, or reword it. */
  updateFinding(
    id: string,
    patch: { state?: 'included' | 'rejected' | 'proposed'; rejectionReason?: string; reason?: string; suggestion?: string },
  ): void {
    const finding = this.store.prReviewFindings.get(id);
    if (!finding) throw new Error('finding not found');
    if (finding.state === 'posted') throw new Error('this finding is already posted to GitHub');
    if (patch.state) this.store.prReviewFindings.setState(id, patch.state, patch.rejectionReason ?? null);
    if (patch.reason !== undefined || patch.suggestion !== undefined) {
      this.store.prReviewFindings.updateText(id, {
        ...(patch.reason !== undefined ? { reason: patch.reason } : {}),
        ...(patch.suggestion !== undefined ? { suggestion: patch.suggestion } : {}),
      });
    }
    const review = this.store.prReviews.get(finding.reviewId);
    if (review) this.broadcast({ t: 'prs.changed', repo: review.repo });
  }

  /**
   * Post the verdict to GitHub as ONE review, with the selected findings as
   * inline comments anchored to their lines.
   *
   * Findings whose anchor no longer survives validation are not dropped: they
   * are appended to the review body. Losing a real finding to a line-number
   * technicality is a worse failure than a slightly longer summary.
   */
  async apply(
    id: string,
    opts: {
      accountId?: string;
      userId?: string;
      findingIds?: readonly string[];
      mode?: ReviewPostMode;
    } = {},
  ): Promise<{ repo: string; number: number }> {
    const result = this.store.prReviews.get(id);
    if (!result?.verdict) throw new Error('review not found or has no verdict');
    if (result.status !== 'pending') throw new Error(`review is ${result.status}, not pending`);
    const client = this.github({ repo: result.repo, accountId: opts.accountId, username: opts.userId });
    if (!client) throw new Error('GitHub is not configured');

    // Anchors are line numbers in ONE commit. If the head moved, they describe
    // a diff that no longer exists and would land on unrelated code.
    const currentHead = this.store.prs.get(result.repo, result.prNumber)?.headSha ?? null;
    if (result.headSha && currentHead && result.headSha !== currentHead) {
      throw new Error(
        'this pull request has new commits since the review ran — re-run the review so its comments land on the current code',
      );
    }

    const mode: ReviewPostMode = opts.mode ?? 'full';
    const selected = this.selectedFindings(id, opts.findingIds);
    // In summary mode nothing is anchored: every selected finding is written
    // into the body instead, so choosing it never silently drops one.
    const { comments, unanchored } =
      mode === 'summary'
        ? { comments: [] as GhReviewCommentInput[], unanchored: selected }
        : await this.buildComments(client, result, selected);

    const event =
      result.verdict.recommendation === 'approve'
        ? 'APPROVE'
        : result.verdict.recommendation === 'request_changes'
          ? 'REQUEST_CHANGES'
          : 'COMMENT';
    // `comments` mode drops the agent's write-up, not its findings: one that
    // could not be anchored has nowhere else to go, and losing a finding the
    // reviewer selected is worse than a short body.
    const prose = mode === 'comments' ? '' : result.verdict.reviewBody;
    const body = composeBody(prose, unanchored) || defaultBody(comments.length);
    const post = (e: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES'): Promise<{ id: number; html_url: string }> =>
      client.createPrReview(result.repo, result.prNumber, {
        body,
        event: e,
        ...(result.headSha ? { commitId: result.headSha } : {}),
        comments,
      });

    let review: { id: number; html_url: string };
    try {
      review = await post(event);
    } catch (err) {
      // GitHub rejects APPROVE/REQUEST_CHANGES from the PR's own author (422)
      // — common here, since the agent's account both opens PRs and reviews.
      // The verdict is still worth publishing: fall back to a comment review.
      //
      // Narrow on the message, not on the status: an anchor GitHub disagrees
      // with is also a 422, and retrying the same comments as COMMENT would
      // fail identically while reporting the wrong cause.
      if (err instanceof GitHubError && err.status === 422 && event !== 'COMMENT' && isOwnPrRejection(err)) {
        log.info('review event rejected by GitHub, posting as comment', {
          repo: result.repo,
          pr: result.prNumber,
          event,
          err: String(err),
        });
        review = await post('COMMENT');
      } else {
        throw err;
      }
    }

    await this.recordPostedComments(client, result, review.id, comments, selected);
    this.store.prReviews.update(id, 'applied');
    this.broadcast({ t: 'prs.changed', repo: result.repo });
    return { repo: result.repo, number: result.prNumber };
  }

  /** Explicit selection wins; otherwise everything the reviewer left armed. */
  private selectedFindings(reviewId: string, findingIds?: readonly string[]): ReviewFinding[] {
    const all = this.store.prReviewFindings.listForReview(reviewId);
    if (findingIds) {
      const wanted = new Set(findingIds);
      return all.filter((f) => wanted.has(f.id) && f.state !== 'posted');
    }
    return all.filter((f) => f.state === 'included');
  }

  /**
   * Turn findings into GitHub comment inputs, validating every anchor against
   * the pull request's own patches (the authority for what GitHub will accept)
   * and dropping ones already said on this pull request.
   */
  private async buildComments(
    client: GitHubClient,
    result: PrReviewResult,
    findings: readonly ReviewFinding[],
  ): Promise<{ comments: GhReviewCommentInput[]; unanchored: ReviewFinding[] }> {
    const { files } = await client.prFiles(result.repo, result.prNumber);
    const index = buildAnchorIndex(unifiedDiffFromPatches(files));
    const existing = await client
      .prReviewComments(result.repo, result.prNumber)
      .catch(() => [] as Array<{ path: string; line: number | null; body: string }>);
    const alreadySaid = new Set(existing.map((c) => dedupeKey(c.path, c.line, c.body)));

    const comments: GhReviewCommentInput[] = [];
    const unanchored: ReviewFinding[] = [];
    for (const finding of findings) {
      const body = commentBody(finding, index);
      if (!finding.anchor) {
        unanchored.push(finding);
        continue;
      }
      const problem = checkAnchor(index, finding.anchor);
      if (problem) {
        log.info('finding could not be anchored, moving to review body', {
          repo: result.repo,
          pr: result.prNumber,
          finding: finding.id,
          problem,
        });
        unanchored.push(finding);
        continue;
      }
      if (alreadySaid.has(dedupeKey(finding.anchor.file, finding.anchor.line, body))) {
        log.info('finding already posted on this PR, skipping', { finding: finding.id });
        continue;
      }
      if (comments.length >= MAX_INLINE_COMMENTS) {
        log.info('inline comment cap reached, remaining findings move to review body', {
          repo: result.repo,
          pr: result.prNumber,
          cap: MAX_INLINE_COMMENTS,
        });
        unanchored.push(finding);
        continue;
      }
      comments.push({
        path: finding.anchor.file,
        body,
        line: finding.anchor.line,
        side: finding.anchor.side,
        ...(finding.anchor.startLine !== null
          ? { start_line: finding.anchor.startLine, start_side: finding.anchor.side }
          : {}),
      });
    }
    return { comments, unanchored };
  }

  /** Map the created comment ids back onto the findings that produced them. */
  private async recordPostedComments(
    client: GitHubClient,
    result: PrReviewResult,
    githubReviewId: number,
    comments: readonly GhReviewCommentInput[],
    findings: readonly ReviewFinding[],
  ): Promise<void> {
    const posted = await client
      .prReviewCommentsFor(result.repo, result.prNumber, githubReviewId)
      .catch((err) => {
        log.warn('could not read back posted review comments', { repo: result.repo, err: String(err) });
        return [] as Array<{ id?: number; path: string; line: number | null }>;
      });
    const idAt = new Map(posted.map((c) => [`${c.path}:${c.line ?? ''}`, c.id ?? null]));
    const sent = new Set(comments.map((c) => `${c.path}:${c.line}`));
    for (const finding of findings) {
      const key = finding.anchor ? `${finding.anchor.file}:${finding.anchor.line}` : null;
      // Everything selected was published — inline when it had a usable anchor,
      // inside the body otherwise — so all of it moves to posted.
      this.store.prReviewFindings.markPosted(
        finding.id,
        key && sent.has(key) ? (idAt.get(key) ?? null) : null,
      );
    }
  }

  dismiss(id: string): void {
    const result = this.store.prReviews.get(id);
    if (!result) throw new Error('review not found');
    this.store.prReviews.update(id, 'dismissed');
    this.store.prReviewFindings.rejectOpen(id);
    this.broadcast({ t: 'prs.changed', repo: result.repo });
  }

  async merge(repo: string, prNumber: number, method: 'merge' | 'squash' | 'rebase', userId: string): Promise<void> {
    const { result, client, tried } = await this.mergeGithub(repo, prNumber, method, { username: userId });
    if (!client || !result) {
      throw new Error(
        tried.length > 0
          ? `none of the connected GitHub accounts (${tried.join(', ')}) can merge pull requests in ${repo}`
          : 'GitHub is not configured',
      );
    }
    if (!result.merged) throw new Error(result.message || 'merge refused by GitHub');
    // Best-effort branch hygiene — a protected or fork branch must not fail the merge.
    await client.deleteMergedPrBranch(repo, prNumber).catch((err) => {
      log.warn('branch delete after merge failed', { repo, prNumber, err: String(err) });
    });
    // The caller (route) re-pulls the PR from GitHub so the cache — and thus the
    // UI — reflects the merged state immediately, not on the next full sync.
  }

  async close(repo: string, prNumber: number, userId: string): Promise<void> {
    const client = this.github({ repo, username: userId });
    if (!client) throw new Error('GitHub is not configured');
    await client.closePr(repo, prNumber);
  }

  /**
   * Agent post-mortem of a PR's failing CI pipelines: given the failing check
   * names, the diff, and the repo checkout, the agent investigates locally
   * (may run builds/tests read-only) and writes a markdown report stored as a
   * ci-analysis report on the PR.
   */
  async analyzeFailedChecks(repo: string, prNumber: number, userId: string): Promise<void> {
    const pr = this.store.prs.get(repo, prNumber);
    if (!pr) throw new Error(`unknown PR ${repo}#${prNumber}`);
    if (!this.github({ repo, username: userId })) throw new Error('GitHub is not configured');
    if (!this.checkouts.hasClone(repo)) throw new Error(`repo ${repo} has no clone yet`);

    const summary = await this.checks.fetchSummary(repo, prNumber, userId);
    const failing = summary.runs.filter(
      (r) => r.status === 'completed' && r.conclusion !== 'success' && r.conclusion !== 'neutral' && r.conclusion !== 'skipped',
    );
    if (failing.length === 0) throw new Error('no failing checks on this PR');

    // The actual logs, not just the check names. Without them the agent is
    // guessing from a label and then re-running the suite locally to find out
    // what it could have read in one request. Best-effort: a repo whose logs
    // have expired still gets the old, weaker analysis rather than no analysis.
    let logs: Array<{ name: string; log: string }> = [];
    if (pr.headSha) {
      const client = this.github({ repo, username: userId });
      logs = (await client?.failingJobLogs(repo, pr.headSha).catch(() => [])) ?? [];
    }

    const { finalMessage } = await this.checkouts.withPullRequestWorktree(
      repo,
      `ci-analysis-${prNumber}-${randomUUID().slice(0, 8)}`,
      prNumber,
      pr.baseRef,
      (cwd) =>
        this.orchestrator.runOneShot({
          kind: 'analysis',
          task: 'code.ci-analysis',
          title: `CI failure analysis — PR #${prNumber}`,
          cwd,
          repo,
          userId,
          issueNumber: prNumber,
          prompt: ciAnalysisPrompt(pr.title, pr.headRef, pr.baseRef, failing, logs),
          timeoutMs: 14 * 60_000,
          resume: { type: 'ci-analysis', args: { repo, number: prNumber, userId } },
        }),
      undefined,
      userId,
    );
    if (!finalMessage?.trim()) throw new Error('CI analysis produced no report');

    this.store.reports.insert({
      id: `rep-${randomUUID().slice(0, 12)}`,
      workspaceId: null,
      repo,
      issueNumber: prNumber,
      kind: 'ci-analysis',
      title: `CI failure analysis — PR #${prNumber}`,
      body: finalMessage.trim(),
      createdAt: Date.now(),
    });
    this.broadcast({ t: 'reports.changed' });
    this.broadcast({ t: 'prs.changed', repo });
  }

  /**
   * The PR gate (webhook → pull_request.opened): analyze, then auto-post ONLY
   * a confident low-risk verdict on a PR whose CI is not failing; anything
   * else stays pending for the human. Merging is never automatic.
   */
  async gate(repo: string, prNumber: number, userId: string): Promise<void> {
    const result = await this.analyzePr(repo, prNumber, userId);
    if (!result.verdict || result.verdict.risk !== 'low') return;
    const checks = this.store.prs.get(repo, prNumber)?.checks ?? null;
    if (checks && checks.state === 'failing') {
      log.info('PR gate: verdict held back (CI failing)', { repo, prNumber });
      return;
    }
    // Nobody consented to THIS review, so the bar for writing on someone's pull
    // request is higher than in the reviewed path: only confirmed blockers go
    // inline. Everything else waits for a human in the pending review.
    const autoPost = result.findings.filter(
      (f) => f.severity === 'blocker' && f.verification === 'confirmed' && f.confidence >= 0.8,
    );
    await this.apply(result.id, { userId, findingIds: autoPost.map((f) => f.id) });
    log.info('PR gate auto-posted review', {
      repo,
      prNumber,
      recommendation: result.verdict.recommendation,
      inline: autoPost.length,
    });
  }

  /**
   * Answer, in thread, a pull request author who replied to one of the agent's
   * inline review comments (webhook → pull_request_review_comment.created).
   *
   * Nobody consented to this conversation, so every gate below refuses rather
   * than guesses: our own comments never trigger it, a comment that is not a
   * reply never triggers it, a thread we did not open is left alone, and a
   * thread we have already answered three times is finished.
   */
  async replyToReviewComment(
    repo: string,
    prNumber: number,
    comment: ReviewCommentPayload,
    userId: string,
  ): Promise<void> {
    const ourLogins = this.store.githubAccounts.logins();
    const decision = reviewCommentTrigger(comment, ourLogins);
    if (!decision.reply) {
      log.info('review reply declined', { repo, prNumber, refusal: decision.refusal });
      return;
    }
    const trigger = decision.trigger;

    const finding = this.store.prReviewFindings.findingByGithubCommentId(trigger.rootId);
    if (!finding) return;
    // A finding row does not carry its repository, so the review is what proves
    // this thread belongs to the pull request the delivery names.
    const review = this.store.prReviews.get(finding.reviewId);
    if (!review || review.repo !== repo || review.prNumber !== prNumber) return;

    const pr = this.store.prs.get(repo, prNumber);
    if (!pr) throw new Error(`unknown PR ${repo}#${prNumber}`);
    const client = this.github({ repo, username: userId });
    if (!client) throw new Error('GitHub is not configured');
    if (!this.checkouts.hasClone(repo)) throw new Error(`repo ${repo} has no clone yet`);

    const comments = await client.prReviewComments(repo, prNumber);
    if (!underReplyCap(comments, trigger.rootId, ourLogins)) {
      log.info('review reply declined', { repo, prNumber, refusal: 'cap-reached' });
      return;
    }
    const thread = comments.filter((c) => c.id === trigger.rootId || c.in_reply_to_id === trigger.rootId);

    const { finalMessage } = await this.checkouts.withPullRequestWorktree(
      repo,
      `review-reply-${prNumber}-${randomUUID().slice(0, 8)}`,
      prNumber,
      pr.baseRef,
      (cwd) =>
        this.orchestrator.runOneShot({
          kind: 'analysis',
          task: 'code.review-reply',
          title: `Review reply on PR #${prNumber}`,
          cwd,
          repo,
          userId,
          issueNumber: prNumber,
          prompt: replyPrompt(finding, pr.baseRef, thread, trigger),
          timeoutMs: 8 * 60_000,
        }),
      undefined,
      userId,
    );

    const body = finalMessage?.trim();
    // Silence is the correct outcome of a run with nothing to say. Posting a
    // placeholder would be worse than not answering.
    if (!body) {
      log.info('review reply produced nothing to post', { repo, prNumber, finding: finding.id });
      return;
    }
    await client.replyToReviewComment(repo, prNumber, trigger.commentId, body);
    this.broadcast({ t: 'prs.changed', repo });
    log.info('review reply posted', { repo, prNumber, finding: finding.id });
  }
}

const DEPTH_GUIDE: Record<ReviewDepth, string> = {
  'high-level': `Review at ARCHITECTURE level. Judge whether the change is the right thing to build and whether it fits the codebase: design, layering, risk, missing cases. Do not go line by line and do not report style or naming points. Anchoring findings to lines is optional here.`,
  'in-depth': `Review IN DEPTH. Go through every changed file and reason about the concrete lines: correctness, edge cases, error handling, resource lifecycle, security, and fit with the surrounding code. ANCHOR every finding you can to the exact line it concerns.`,
};

const STRICTNESS_GUIDE: Record<ReviewStrictness, string> = {
  'blockers-only': `The reviewer wants only what would break something or must not ship. Do not pad the list.`,
  balanced: `Report what a careful colleague would raise in review: correctness and design issues, plus clear maintainability problems. Skip pure taste.`,
  pedantic: `Report everything you would raise if you were being thorough, nits included, but label them honestly.`,
};

function reviewPrompt(opts: {
  title: string;
  body: string;
  author: string;
  baseRef: string;
  checks: string;
  depth: ReviewDepth;
  strictness: ReviewStrictness;
  dismissed: ReadonlyArray<{ title: string; reason: string }>;
  context?: string;
}): string {
  return `You are reviewing a GitHub pull request against the repository checked out in the current directory (branch ${opts.baseRef}).

READ-ONLY RULES (mandatory): you may read files and search the codebase for context, but you must NOT modify anything. Your ONLY output is the final JSON.

## PR: ${opts.title}
Author: ${opts.author}

${opts.body || '(no description)'}

## CI pipelines
${opts.checks}
${opts.context ? `\n## Review context\n${opts.context}\n` : ''}
${diffInspectionGuide(opts.baseRef)}

## How to review
${DEPTH_GUIDE[opts.depth]}
${STRICTNESS_GUIDE[opts.strictness]}
${dismissedSection(opts.dismissed)}

## Anchoring findings
A finding may only be anchored to a line that is PART OF THE DIFF (\`git diff origin/${opts.baseRef}...HEAD\`). Lines you read for context but that the pull request does not touch cannot be anchored.

- \`file\` is the path as it appears in the diff, \`line\` its number in the NEW file, and \`side\` is "RIGHT". Use \`side\`: "LEFT" with the OLD file's numbering only to comment on a deleted line.
- \`quotedLine\` MUST be the exact text of the line you anchored to, copied from the diff. It is checked against the real diff, and a finding whose quote does not match is discarded as unreliable.
- \`startLine\` opens a multi-line range ending at \`line\`; omit it for a single line.
- Have a real point that is not in the diff? Report it with \`file\`, \`line\` and \`side\` set to null. It still reaches the reviewer.
- \`suggestedPatch\` is the literal replacement text for the anchored lines, no fences and no diff markers, so it can be offered as a one-click fix. Omit it unless you are confident it compiles.

Assign \`severity\` honestly: "blocker" breaks something or must not ship, "major" is a real defect worth fixing before merge, "minor" is a genuine improvement, "nit" is taste. Do not inflate a severity to make a point more likely to be read.

## Your task
Assess correctness, risk, and fit with the surrounding code, then reply with ONLY a JSON object (no fence, no prose) of exactly this shape:
{
  "summary": "<2-3 sentence assessment of what the PR does and its quality>",
  "risk": "low" | "medium" | "high",
  "recommendation": "approve" | "request_changes" | "comment",
  "findings": [
    {
      "title": "<one line naming the problem>",
      "severity": "blocker" | "major" | "minor" | "nit",
      "file": "<path in the diff, or null>",
      "side": "RIGHT" | "LEFT" | null,
      "line": <line number, or null>,
      "startLine": <start of a multi-line range, or null>,
      "quotedLine": "<exact text of that line, or null>",
      "reason": "<why it is wrong, concretely>",
      "impact": "<what goes wrong in practice if it ships>",
      "suggestion": "<what to do about it>",
      "suggestedPatch": "<literal replacement for the anchored lines, or null>",
      "confidence": <0.0 to 1.0>
    }
  ],
  "reviewBody": "<the overall review comment to post on the PR, markdown, friendly and specific. Do NOT repeat the per-line findings here; they are posted as inline comments.>"
}
Weigh the CI pipeline status in your assessment: failing or missing CI raises risk; do not recommend "approve" while required pipelines are failing.`;
}

/**
 * What reviewers on this repository have already rejected, with their reasons.
 *
 * Phrased as calibration rather than prohibition: this is evidence about the
 * team's conventions, and a model told outright not to mention something will
 * also stay quiet when the same shape of code is genuinely broken.
 */
function dismissedSection(dismissed: ReadonlyArray<{ title: string; reason: string }>): string {
  if (dismissed.length === 0) return '';
  const lines = dismissed.map((d) => `- "${d.title}" — reviewer said: ${d.reason}`).join('\n');
  return `
## Previously dismissed on this repository
Reviewers here have rejected these minor points, with their reasoning. Treat it as evidence about this team's conventions and do not re-raise the same points unless the code genuinely differs. This says nothing about correctness or security problems, which you should always report.

${lines}
`;
}

const verificationSchema = z.object({
  refuted: z.boolean(),
  reason: z.string().max(4000).default(''),
});

function verifyPrompt(finding: ReviewFinding, baseRef: string): string {
  const where = finding.anchor
    ? `${finding.anchor.file}:${finding.anchor.startLine ? `${finding.anchor.startLine}-` : ''}${finding.anchor.line} (${finding.anchor.side} side of the diff)`
    : '(not anchored to a specific line)';
  return `A code reviewer has made the following claim about the pull request checked out in the current directory. Your job is to REFUTE it.

## The claim
${finding.title}

Location: ${where}
Severity claimed: ${finding.severity}
Argument: ${finding.reason || '(none given)'}
Claimed consequence: ${finding.impact || '(none given)'}

## Rules
- You have NOT seen the reasoning that produced this claim beyond what is quoted above, and you should not assume it was sound.
- Read the actual code. Check the diff with \`git diff origin/${baseRef}...HEAD\` and read the surrounding files.
- Look specifically for reasons the claim is WRONG: a guard elsewhere, a type that makes the case impossible, a convention in this codebase, a misread of the diff, a line that is not what the claim says it is.
- READ-ONLY: do not modify anything.
- Default to refuted. If you cannot demonstrate the problem is real, it is refuted. "Might be a problem" is refuted.

Reply with ONLY a JSON object (no fence, no prose):
{ "refuted": true | false, "reason": "<what you checked and what you concluded>" }`;
}

/**
 * Answering the author of a pull request in their own thread.
 *
 * The instruction to concede is the important half: this reply is posted
 * publicly under the agent's own finding, and a model that defends every claim
 * it made turns a review into an argument nobody can end.
 */
function replyPrompt(
  finding: ReviewFinding,
  baseRef: string,
  thread: ReadonlyArray<{ user: { login: string } | null; body: string }>,
  reply: ReviewCommentTrigger,
): string {
  const where = finding.anchor
    ? `${finding.anchor.file}:${finding.anchor.startLine ? `${finding.anchor.startLine}-` : ''}${finding.anchor.line} (${finding.anchor.side} side of the diff)`
    : '(not anchored to a specific line)';
  const transcript = thread
    .map((c) => `**${c.user?.login ?? 'unknown'}**: ${c.body.trim()}`)
    .join('\n\n');
  return `You left an inline comment while reviewing a GitHub pull request, and its author has replied to you. The pull request head is checked out in the current directory, and \`origin/${baseRef}\` is the refreshed base, so \`git diff origin/${baseRef}...HEAD\` is the change under discussion.

READ-ONLY RULES (mandatory): you may read files and search the codebase for context, but you must NOT modify, commit or push anything. Your only output is the reply itself.

## Your finding
[${finding.severity}] ${finding.title}

Location: ${where}
Argument: ${finding.reason || '(none recorded)'}
Claimed consequence: ${finding.impact || '(none recorded)'}
What you suggested: ${finding.suggestion || '(nothing recorded)'}

## The thread so far
${transcript || '(only your original comment)'}

## What ${reply.author} just said
${reply.body}

## How to answer
- Go and check the code before you answer. Reading it again is the entire point; asserting from memory is not.
- If they are right, say so plainly and say what you missed. Being talked out of a wrong finding is a success here, not a loss.
- If you still believe the finding, say why, with specific evidence: the file, the line, and what it actually does.
- If the code cannot settle it, say that instead of manufacturing certainty.
- Write ONLY the reply body, in prose, as a short GitHub comment. No JSON, no headings, no sign-off. It is posted verbatim.`;
}

/** The verdict with its findings still structured, before they become rows. */
function parseVerdictWithFindings(text: string): z.infer<typeof verdictSchema> {
  return verdictSchema.parse(extractModelJson(text));
}

/**
 * Turn what the model reported into storable findings, dropping anchors that
 * do not survive validation rather than the findings that carry them.
 */
function toFindings(
  reviewId: string,
  reported: ReadonlyArray<ModelFinding | string>,
  index: ReturnType<typeof buildAnchorIndex> | null,
  strictness: ReviewStrictness,
): ReviewFinding[] {
  const now = Date.now();
  return reported.map((item) => {
    const model: ModelFinding =
      typeof item === 'string'
        ? { title: item, severity: 'minor', reason: '', impact: '', suggestion: '', confidence: 0.5 }
        : item;
    let anchor: ReviewFinding['anchor'] = null;
    if (model.file && model.line && model.side) {
      const candidate = {
        file: model.file,
        side: model.side,
        line: model.line,
        startLine: model.startLine ?? null,
      };
      const problem = index ? checkAnchor(index, candidate, model.quotedLine) : null;
      if (problem) {
        log.info('dropping unusable anchor from finding', { title: model.title, problem });
      } else {
        anchor = candidate;
      }
    }
    return {
      id: `prf-${randomUUID().slice(0, 12)}`,
      reviewId,
      source: 'native',
      anchor,
      severity: model.severity,
      title: model.title,
      reason: model.reason,
      impact: model.impact,
      suggestion: model.suggestion,
      suggestedPatch: model.suggestedPatch ?? null,
      confidence: model.confidence,
      // Strictness decides what starts ARMED, never what is kept: the reviewer
      // can reveal and include the rest without paying for a second run.
      state: meetsStrictness(model.severity, strictness) ? 'included' : 'proposed',
      verification: 'unverified',
      verificationNote: null,
      rejectionReason: null,
      githubCommentId: null,
      createdAt: now,
    };
  });
}

const SEVERITY_LABEL: Record<FindingSeverity, string> = {
  blocker: '🔴 Blocker',
  major: '🟠 Major',
  minor: '🟡 Minor',
  nit: '⚪ Nit',
};

/**
 * One finding as the markdown body of a GitHub review comment.
 *
 * A comment the reviewer typed is posted as they wrote it. Prefixing it with a
 * severity badge would present a human's words as a tool's verdict.
 */
function commentBody(finding: ReviewFinding, index: ReturnType<typeof buildAnchorIndex>): string {
  if (finding.source === 'human') return finding.reason.trim() || finding.title;
  const parts = [`**${SEVERITY_LABEL[finding.severity]}** — ${finding.title}`];
  if (finding.reason.trim()) parts.push(finding.reason.trim());
  if (finding.impact.trim()) parts.push(`_Impact:_ ${finding.impact.trim()}`);
  if (finding.suggestion.trim()) parts.push(finding.suggestion.trim());
  const patch = usableSuggestion(finding, index);
  if (patch !== null) parts.push('```suggestion\n' + patch + '\n```');
  return parts.join('\n\n');
}

/**
 * A ```suggestion block replaces exactly the anchored range when the author
 * clicks it, so a patch whose line count disagrees with that range would
 * silently delete or duplicate code. Those are rendered as a plain snippet
 * inside the comment text instead of an applicable suggestion.
 */
function usableSuggestion(finding: ReviewFinding, index: ReturnType<typeof buildAnchorIndex>): string | null {
  const patch = finding.suggestedPatch?.replace(/\n+$/, '');
  if (!patch || !finding.anchor) return null;
  const anchored = finding.anchor.startLine === null ? 1 : finding.anchor.line - finding.anchor.startLine + 1;
  if (patch.split('\n').length !== anchored) return null;
  // Only ever offered against the new file: GitHub applies a suggestion to the
  // head, and a LEFT-side anchor names a line that is already gone.
  if (finding.anchor.side !== 'RIGHT') return null;
  if (!index.has(finding.anchor.file, 'RIGHT', finding.anchor.line)) return null;
  return patch;
}

/**
 * A review still needs something to say when its whole content is inline
 * comments, which is the normal shape of a manual draft.
 */
function defaultBody(inline: number): string {
  return inline > 0 ? `${inline} inline comment${inline === 1 ? '' : 's'}.` : 'Reviewed.';
}

/** The review body, with anything that could not be anchored appended to it. */
function composeBody(reviewBody: string, unanchored: readonly ReviewFinding[]): string {
  if (unanchored.length === 0) return reviewBody;
  const heading = reviewBody.trim()
    ? '\n\n---\n\n**Further points** (not tied to a line of this diff):\n\n'
    : '**Points not tied to a line of this diff:**\n\n';
  const lines = unanchored.map((f) => {
    const where = f.anchor ? ` (\`${f.anchor.file}:${f.anchor.line}\`)` : '';
    const detail = [f.reason, f.impact ? `_Impact:_ ${f.impact}` : '', f.suggestion]
      .filter((s) => s.trim())
      .join(' ');
    return `- **${SEVERITY_LABEL[f.severity]}** ${f.title}${where}${detail ? `\n  ${detail}` : ''}`;
  });
  return `${reviewBody}${heading}${lines.join('\n')}`;
}

/** Same file, same line, same opening sentence — said already, do not repeat. */
function dedupeKey(path: string, line: number | null, body: string): string {
  return `${path}:${line ?? ''}:${body.replace(/\s+/g, ' ').trim().slice(0, 120).toLowerCase()}`;
}

/**
 * GitHub answers "you cannot review your own pull request" with the same 422 it
 * uses for a comment anchored outside the diff, and only the message separates
 * them. `GitHubError` already folds the `errors[]` details into it.
 */
function isOwnPrRejection(err: GitHubError): boolean {
  return /your own pull request/i.test(err.message);
}

function ciAnalysisPrompt(
  title: string,
  headRef: string,
  baseRef: string,
  failing: ReadonlyArray<{ name: string; conclusion: string | null; detailsUrl: string | null }>,
  logs: ReadonlyArray<{ name: string; log: string }>,
): string {
  const list = failing
    .map((f) => `- ${f.name}: ${f.conclusion ?? 'failed'}${f.detailsUrl ? ` (${f.detailsUrl})` : ''}`)
    .join('\n');
  const logSection = logs.length
    ? `\n## Job logs (tail of each failing job)\n${logs
        .map((l) => `### ${l.name}\n\`\`\`\n${l.log}\n\`\`\``)
        .join('\n\n')}\n`
    : '\n(Job logs were unavailable — expired, still running, or not an Actions job. Reproduce locally instead.)\n';
  return `You are investigating why CI pipelines are failing on the pull request "${title}" (branch ${headRef}). The pull request head is checked out in the current directory.

RULES: you may read files, search, and run non-destructive commands (installs into the existing environment, builds, linters, test suites) to reproduce the failures locally. You must NOT modify, commit, or push anything.

## Failing pipelines
${list}
${logSection}
${diffInspectionGuide(baseRef)}

## Your task
Read the logs above FIRST: the answer is usually in them, and reproducing a
failure you have already been shown the error for wastes the run. Then figure out
the most likely cause of each failing pipeline. Where the logs are absent or
inconclusive, reproduce locally (e.g. run the linter or the test suite the check corresponds to) against the diff's changes. Reply with a concise markdown report:
1. **Verdict per failing check** — probable cause, evidence, and whether you reproduced it.
2. **Suggested fix** — concrete change(s) the author should make.
3. **Confidence** — high/medium/low per finding.`;
}

function diffInspectionGuide(baseRef: string): string {
  return `## Inspecting the complete PR
The current checkout is the exact PR head and \`origin/${baseRef}\` is the refreshed base. Inspect the complete change locally; no prompt-sized diff was provided.

- Start with \`git diff --stat origin/${baseRef}...HEAD\`, \`git diff --numstat origin/${baseRef}...HEAD\`, and \`git diff --name-only origin/${baseRef}...HEAD\`.
- Review changed files in bounded groups with \`git diff origin/${baseRef}...HEAD -- <path>...\`; do not dump an oversized whole-PR diff into one tool call.
- Cover every changed file. Generated, vendored, lock, and binary files may be classified and sampled instead of expanded line-by-line.
- If collaboration/subagent tools are available, delegate disjoint file groups and synthesize their evidence yourself. Do not assume delegation exists.`;
}
