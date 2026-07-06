import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PrReviewResult, PrReviewVerdict, SpaServerMessage } from '@companion/contract';
import { log } from '../log.js';
import type { Store } from '../store/db.js';
import type { Orchestrator } from '../runs/orchestrator.js';
import type { Checkouts } from '../git/checkouts.js';
import type { GitHubClient } from '../github/client.js';
import { extractModelJson } from '../lib/model-json.js';

const verdictSchema = z.object({
  summary: z.string(),
  risk: z.enum(['low', 'medium', 'high']),
  recommendation: z.enum(['approve', 'request_changes', 'comment']),
  findings: z.array(z.string()).max(15),
  reviewBody: z.string(),
});

const MAX_DIFF_CHARS = 60_000;

/**
 * PR reviews, review-then-apply like triage: an agent reads the PR diff
 * against the repo checkout and returns a structured verdict; posting the
 * review / merging / closing only happens on explicit human action — except
 * when the repo's PR gate auto-posts a confident verdict (see Automations).
 */
export class PrReviews {
  constructor(
    private readonly store: Store,
    private readonly orchestrator: Orchestrator,
    private readonly checkouts: Checkouts,
    private readonly github: () => GitHubClient | null,
    private readonly broadcast: (msg: SpaServerMessage) => void,
  ) {}

  async analyzePr(repo: string, prNumber: number): Promise<PrReviewResult> {
    const pr = this.store.getPr(repo, prNumber);
    if (!pr) throw new Error(`unknown PR ${repo}#${prNumber}`);
    const client = this.github();
    if (!client) throw new Error('GitHub is not configured');
    if (!this.checkouts.hasClone(repo)) throw new Error(`repo ${repo} has no clone yet`);

    const diff = await client.prDiff(repo, prNumber);
    const clippedDiff =
      diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n… (diff truncated)` : diff;

    const { runId, finalMessage } = await this.orchestrator.runOneShot({
      kind: 'analysis',
      title: `Review PR #${prNumber}: ${pr.title.slice(0, 60)}`,
      cwd: this.checkouts.cloneDir(repo),
      repo,
      issueNumber: prNumber,
      prompt: reviewPrompt(pr.title, pr.body, pr.author, pr.baseRef, clippedDiff),
      timeoutMs: 8 * 60_000,
    });

    let verdict: PrReviewVerdict | null = null;
    let error: string | null = null;
    try {
      verdict = parseReviewVerdict(finalMessage ?? '');
    } catch (err) {
      error = `could not parse review verdict: ${String(err)}`;
      log.warn('pr review parse failed', { repo, prNumber, err: String(err) });
    }

    const result: PrReviewResult = {
      id: `prr-${randomUUID().slice(0, 12)}`,
      repo,
      prNumber,
      runId,
      status: verdict ? 'pending' : 'failed',
      verdict,
      error,
      createdAt: Date.now(),
    };
    this.store.insertPrReview(result);
    this.broadcast({ t: 'prs.changed', repo });
    return result;
  }

  /** Post the verdict to GitHub as a PR review. */
  async apply(id: string): Promise<void> {
    const result = this.store.getPrReview(id);
    if (!result?.verdict) throw new Error('review not found or has no verdict');
    if (result.status !== 'pending') throw new Error(`review is ${result.status}, not pending`);
    const client = this.github();
    if (!client) throw new Error('GitHub is not configured');

    const event =
      result.verdict.recommendation === 'approve'
        ? 'APPROVE'
        : result.verdict.recommendation === 'request_changes'
          ? 'REQUEST_CHANGES'
          : 'COMMENT';
    await client.createPrReview(result.repo, result.prNumber, {
      body: result.verdict.reviewBody,
      event,
    });
    this.store.updatePrReview(id, 'applied');
    this.broadcast({ t: 'prs.changed', repo: result.repo });
  }

  dismiss(id: string): void {
    const result = this.store.getPrReview(id);
    if (!result) throw new Error('review not found');
    this.store.updatePrReview(id, 'dismissed');
    this.broadcast({ t: 'prs.changed', repo: result.repo });
  }

  async merge(repo: string, prNumber: number, method: 'merge' | 'squash' | 'rebase'): Promise<void> {
    const client = this.github();
    if (!client) throw new Error('GitHub is not configured');
    const result = await client.mergePr(repo, prNumber, method);
    if (!result.merged) throw new Error(result.message || 'merge refused by GitHub');
    this.broadcast({ t: 'prs.changed', repo });
  }

  async close(repo: string, prNumber: number): Promise<void> {
    const client = this.github();
    if (!client) throw new Error('GitHub is not configured');
    await client.closePr(repo, prNumber);
    this.broadcast({ t: 'prs.changed', repo });
  }

  /**
   * The PR gate (webhook → pull_request.opened): analyze, then auto-post ONLY
   * a confident low-risk verdict; anything else stays pending for the human.
   * Merging is never automatic.
   */
  async gate(repo: string, prNumber: number): Promise<void> {
    const result = await this.analyzePr(repo, prNumber);
    if (result.verdict && result.verdict.risk === 'low') {
      await this.apply(result.id);
      log.info('PR gate auto-posted review', { repo, prNumber, recommendation: result.verdict.recommendation });
    }
  }
}

function reviewPrompt(title: string, body: string, author: string, baseRef: string, diff: string): string {
  return `You are reviewing a GitHub pull request against the repository checked out in the current directory (branch ${baseRef}).

READ-ONLY RULES (mandatory): you may read files and search the codebase for context, but you must NOT modify anything. Your ONLY output is the final JSON.

## PR: ${title}
Author: ${author}

${body || '(no description)'}

## Diff
\`\`\`diff
${diff}
\`\`\`

## Your task
Assess correctness, risk, and fit with the surrounding code, then reply with ONLY a JSON object (no fence, no prose) of exactly this shape:
{
  "summary": "<2-3 sentence assessment of what the PR does and its quality>",
  "risk": "low" | "medium" | "high",
  "recommendation": "approve" | "request_changes" | "comment",
  "findings": ["<specific issues or observations, empty if none>"],
  "reviewBody": "<the full review comment to post on the PR, markdown, friendly and specific>"
}`;
}

export function parseReviewVerdict(text: string): PrReviewVerdict {
  return verdictSchema.parse(extractModelJson(text)) as PrReviewVerdict;
}
