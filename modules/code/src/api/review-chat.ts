import { randomUUID } from 'node:crypto';
import { log } from '@moxxy/companion-sdk/server';
import type { SpaServerMessage } from '@moxxy/companion-contracts';
import type { AskRequest } from '@moxxy/companion-sdk/agents';
import type { ReviewFinding } from '../contract/index.js';
import type { CodeStore } from './code-store.js';
import type { Checkouts, Orchestrator } from './operate-types.js';

/** Nobody has spoken for this long: stop the run and give the worktree back. */
const IDLE_REAP_MS = 20 * 60_000;

/**
 * Everything before this in a prompt is context the daemon added, not something
 * the user typed, and the transcript folds it away. Same device as AI Help's
 * briefing marker, for the same reason.
 */
export const CHAT_MARKER = '<<<REVIEWER_MESSAGE>>>';

/**
 * Discussing a review with the agent that produced it.
 *
 * ONE conversation per review, not per finding. A question about the third
 * finding is usually a question about the first as well, and a run per finding
 * would multiply the cost of the thing it explains. The UI still presents a
 * thread per finding; a message simply names which one it is about, and the
 * agent is told to answer that one.
 *
 * The run holds a worktree of the pull request between turns, because an agent
 * asked "is this really a bug" must be able to go and look. That worktree is
 * the reason for the reaper: an abandoned conversation would otherwise keep a
 * checkout on disk indefinitely.
 */
export class ReviewChat {
  /** Last message per conversation run, feeding the idle reaper. */
  private readonly lastActivity = new Map<string, number>();

  constructor(
    private readonly store: CodeStore,
    private readonly orchestrator: Orchestrator,
    private readonly checkouts: Checkouts,
    private readonly broadcast: (msg: SpaServerMessage) => void,
  ) {
    setInterval(() => this.reapIdle(), 60_000).unref();
  }

  private mapKey(reviewId: string): string {
    return `review:chat:${reviewId}`;
  }

  private runIdFor(reviewId: string): string | null {
    return this.store.settings.get(this.mapKey(reviewId)) || null;
  }

  /** The conversation's run, if one has been started and still exists. */
  runFor(reviewId: string): { id: string; live: boolean } | null {
    const runId = this.runIdFor(reviewId);
    if (!runId) return null;
    const run = this.orchestrator.getRun(runId);
    return run ? { id: run.id, live: run.live } : null;
  }

  async history(reviewId: string, before: number | null, limit: number): Promise<unknown> {
    const runId = this.runIdFor(reviewId);
    if (!runId) return { events: [], prevCursor: null };
    return this.orchestrator.loadHistory(runId, before, limit);
  }

  /** Whatever the agent is waiting on. An unanswered ask stalls the turn. */
  pendingAsks(reviewId: string): AskRequest[] {
    const runId = this.runIdFor(reviewId);
    return runId ? this.orchestrator.pendingAsksFor(runId) : [];
  }

  async respondAsk(reviewId: string, requestId: string, response: Record<string, unknown>): Promise<void> {
    const runId = this.runIdFor(reviewId);
    if (!runId) throw new Error('no discussion on this review yet');
    await this.orchestrator.respondAsk(runId, requestId, response);
    this.lastActivity.set(runId, Date.now());
  }

  /**
   * Ask about one finding. The first message of a conversation carries the
   * review's full context; later ones only name the finding, because the run
   * already holds everything else.
   */
  async ask(
    reviewId: string,
    findingId: string | null,
    text: string,
    userId: string,
  ): Promise<{ turnId: string; runId: string }> {
    const review = this.store.prReviews.get(reviewId);
    if (!review) throw new Error('review not found');
    const findings = this.store.prReviewFindings.listForReview(reviewId);
    const finding = findingId ? findings.find((f) => f.id === findingId) : undefined;
    if (findingId && !finding) throw new Error('finding not found on this review');

    const runId = await this.ensureRun(reviewId, userId);
    const primedKey = `review:chat:primed:${runId}`;
    const primed = this.store.settings.get(primedKey) === '1';
    const context = primed ? '' : `${briefing(review.repo, review.prNumber, findings)}\n\n`;
    const prompt = `${context}${CHAT_MARKER}\n${followUpPrompt(finding, text)}`;

    const result = await this.orchestrator.sendPrompt(runId, prompt);
    if (!primed) this.store.settings.set(primedKey, '1');
    this.lastActivity.set(runId, Date.now());
    this.broadcast({ t: 'prs.changed', repo: review.repo });
    // The run id travels back so the caller can subscribe to the stream: on the
    // first message of a conversation there is nothing else to learn it from.
    return { ...result, runId };
  }

  /** Attach to the conversation, creating it (and its checkout) on first use. */
  private async ensureRun(reviewId: string, userId: string): Promise<string> {
    const existing = this.runIdFor(reviewId);
    if (existing) {
      const run = this.orchestrator.getRun(existing);
      if (run && run.status !== 'failed' && run.status !== 'abandoned') {
        if (run.live) return run.id;
        try {
          const resumed = await this.orchestrator.resumeRun(run.id);
          return resumed.id;
        } catch (err) {
          // The worktree behind a dead run is gone or unusable; start over
          // rather than talk to an agent that cannot read the code.
          log.warn('review chat resume failed — starting a new conversation', { reviewId, err: String(err) });
          await this.teardown(run.id);
        }
      }
    }

    const review = this.store.prReviews.get(reviewId);
    if (!review) throw new Error('review not found');
    const pr = this.store.prs.get(review.repo, review.prNumber);
    if (!pr) throw new Error(`unknown PR ${review.repo}#${review.prNumber}`);
    if (!this.checkouts.hasClone(review.repo)) throw new Error(`repo ${review.repo} has no clone yet`);

    const key = `review-chat-${review.prNumber}-${randomUUID().slice(0, 8)}`;
    const cwd = await this.checkouts.addPullRequestWorktree(
      review.repo,
      key,
      review.prNumber,
      pr.baseRef,
      undefined,
      userId,
    );
    let run;
    try {
      run = await this.orchestrator.createRun({
        kind: 'analysis',
        task: 'code.review-chat',
        title: `Review discussion — PR #${review.prNumber}`,
        cwd,
        repo: review.repo,
        issueNumber: review.prNumber,
        userId,
      });
    } catch (err) {
      // The run never existed, so nothing else will ever remove this checkout.
      await this.checkouts.removeWorktree(review.repo, cwd).catch(() => undefined);
      throw err;
    }
    this.store.settings.set(this.mapKey(reviewId), run.id);
    this.store.settings.set(`review:chat:primed:${run.id}`, '0');
    this.lastActivity.set(run.id, Date.now());
    return run.id;
  }

  /**
   * Stop the conversation and give its checkout back.
   *
   * The worktree is read off the run record rather than remembered in memory:
   * a daemon restart forgets a map, and a forgotten worktree is one nothing
   * will ever remove.
   */
  private async teardown(runId: string): Promise<void> {
    const run = this.orchestrator.getRun(runId);
    await this.orchestrator.stopRun(runId).catch(() => undefined);
    if (run?.repo && run.cwd) {
      await this.checkouts.removeWorktree(run.repo, run.cwd).catch(() => undefined);
    }
    this.lastActivity.delete(runId);
  }

  /**
   * Stop conversations nobody is having any more.
   *
   * A pending ask is not idleness — the agent is waiting on the human — so it
   * gets the same grace as an active turn.
   */
  private reapIdle(): void {
    for (const run of this.orchestrator.listRuns()) {
      if (run.task !== 'code.review-chat' || !run.live) continue;
      const lastSeen = Math.max(this.lastActivity.get(run.id) ?? 0, run.updatedAt);
      if (this.orchestrator.pendingAsksFor(run.id).length > 0) continue;
      if (Date.now() - lastSeen > IDLE_REAP_MS) {
        log.info('reaping idle review conversation', { runId: run.id });
        void this.teardown(run.id);
      }
    }
  }
}

function briefing(repo: string, prNumber: number, findings: readonly ReviewFinding[]): string {
  const list = findings
    .map((f, i) => {
      const where = f.anchor ? `${f.anchor.file}:${f.anchor.line}` : 'no line anchor';
      return `${i + 1}. [${f.severity}] ${f.title} (${where})\n   ${f.reason || '(no reasoning recorded)'}`;
    })
    .join('\n');
  return `You reviewed pull request ${repo}#${prNumber}. Its head is checked out in the current directory; \`origin/<base>\` is the refreshed base, so \`git diff origin/<base>...HEAD\` is the change under discussion.

A human reviewer is now going through your findings and will ask you about them one at a time.

## The findings you produced
${list || '(none)'}

## How to answer
- READ-ONLY: you may read files and search the repository, but must NOT modify anything.
- Go and check before you answer. "Looking at the code again" is the point of this conversation; asserting from memory is not.
- If the reviewer shows you that a finding is wrong, say so plainly and explain what you missed. Being talked out of a wrong finding is a success here, not a loss.
- If you still believe it, say why, with the specific evidence.
- Answer in prose, not JSON. Keep it short unless asked to go deeper.`;
}

function followUpPrompt(finding: ReviewFinding | undefined, text: string): string {
  if (!finding) return text;
  const where = finding.anchor ? ` (${finding.anchor.file}:${finding.anchor.line})` : '';
  return `About finding "${finding.title}"${where}:\n\n${text}`;
}
