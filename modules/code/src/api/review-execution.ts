import { DEFAULT_MAX_PR_REVIEW_TOKENS, type PrReviewBudgetProgress } from '../contract/index.js';

/** Aggregate guardrails for one PR review, across every child agent run. */
export const MAX_REVIEW_MODEL_CALLS = 20;
export const MAX_REVIEW_WALL_MS = 60 * 60_000;
/** Starting another turn this close to the hard stop only creates churn. */
export const MIN_REVIEW_CALL_MS = 30_000;

interface ReviewExecutionOptions {
  readonly maxModelCalls?: number;
  readonly maxTokens?: number;
  readonly wallMs?: number;
  readonly now?: () => number;
}

/** Structural seam from Operate; pricing and harness interpretation stay there. */
export interface ReviewRunUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number | null;
  readonly telemetry: 'reported' | 'missing' | 'unsupported';
}

/**
 * One aggregate PR-review execution budget.
 *
 * A split review is many queued runs, but it is one user operation. The budget
 * is therefore claimed before queueing each child and is monotonic: cancelling
 * a queued child does not refund it and permit an unbounded retry loop. The
 * queue/run sets are deliberately in memory; durable truth is the review row,
 * whose boot recovery fails any work the old process could no longer control.
 */
export class ReviewExecution {
  readonly startedAt: number;
  readonly deadlineAt: number;
  readonly maxModelCalls: number;
  readonly maxTokens: number;

  private readonly now: () => number;
  private modelCalls = 0;
  private stoppedReason: string | null = null;
  private readonly queued = new Set<string>();
  private readonly running = new Set<string>();
  /** Latest cumulative usage per child; provider events may repeat or arrive out of order. */
  private readonly observedUsage = new Map<string, ReviewRunUsage>();
  private readonly missingUsage = new Set<string>();
  /** A settled promise or duplicate callback must never charge the same run twice. */
  private readonly accountedRuns = new Set<string>();

  constructor(opts: ReviewExecutionOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.maxModelCalls = positiveInt(opts.maxModelCalls, MAX_REVIEW_MODEL_CALLS);
    this.maxTokens = positiveInt(opts.maxTokens, DEFAULT_MAX_PR_REVIEW_TOKENS);
    const wallMs = Math.max(MIN_REVIEW_CALL_MS, positiveInt(opts.wallMs, MAX_REVIEW_WALL_MS));
    this.startedAt = this.now();
    this.deadlineAt = this.startedAt + wallMs;
  }

  /** Claim one child turn and return the timeout that fits inside the wall budget. */
  claim(requestedTimeoutMs: number, reserveCalls = 0): number {
    if (this.stoppedReason) throw new Error(this.stoppedReason);
    const remainingMs = this.remainingMs();
    if (remainingMs < MIN_REVIEW_CALL_MS) {
      const reason = 'aggregate review time budget exhausted';
      this.stop(reason);
      throw new Error(reason);
    }
    const reserve = Math.max(0, Math.floor(reserveCalls));
    if (this.modelCalls + 1 + reserve > this.maxModelCalls) {
      throw new Error('aggregate review agent-call budget exhausted');
    }
    this.modelCalls += 1;
    return Math.min(Math.max(1, Math.floor(requestedTimeoutMs)), remainingMs);
  }

  remainingCalls(reserveCalls = 0): number {
    return Math.max(0, this.maxModelCalls - this.modelCalls - Math.max(0, Math.floor(reserveCalls)));
  }

  remainingMs(): number {
    return Math.max(0, this.deadlineAt - this.now());
  }

  stop(reason: string): void {
    this.stoppedReason ??= reason;
  }

  get stopped(): boolean {
    return this.stoppedReason !== null;
  }

  trackQueued(queueId: string): void {
    this.queued.add(queueId);
  }

  trackStarted(queueId: string | null, runId: string): void {
    if (queueId) this.queued.delete(queueId);
    this.running.add(runId);
  }

  trackFinished(queueId: string | null, runId: string | null): void {
    if (queueId) this.queued.delete(queueId);
    if (runId) this.running.delete(runId);
  }

  /**
   * Fold a cumulative in-flight snapshot. Runtime events are untrusted and may
   * repeat, so only monotonic maxima count. Returns a newly-triggered stop
   * reason so the owner can terminalize the aggregate before stopping peers.
   */
  observeUsage(runId: string, usage: ReviewRunUsage | null): string | null {
    if (this.accountedRuns.has(runId) || !usage || usage.telemetry !== 'reported') return null;
    const wasStopped = this.stoppedReason !== null;
    const previous = this.observedUsage.get(runId);
    this.observedUsage.set(runId, {
      inputTokens: Math.max(previous?.inputTokens ?? 0, tokenCount(usage.inputTokens)),
      outputTokens: Math.max(previous?.outputTokens ?? 0, tokenCount(usage.outputTokens)),
      estimatedCostUsd:
        usage.estimatedCostUsd === null || !Number.isFinite(usage.estimatedCostUsd)
          ? (previous?.estimatedCostUsd ?? null)
          : Math.max(previous?.estimatedCostUsd ?? 0, usage.estimatedCostUsd),
      telemetry: 'reported',
    });

    if (this.totalTokens() >= this.maxTokens) {
      const reason = 'aggregate review token budget exhausted';
      this.stop(reason);
      return wasStopped ? null : reason;
    }
    return null;
  }

  /**
   * Finalize one child exactly once. Missing telemetry fails closed: call/time
   * limits still exist, but claiming a token ceiling is safe while the counter
   * is blind would be misleading.
   */
  recordUsage(runId: string, usage: ReviewRunUsage | null): string | null {
    if (this.accountedRuns.has(runId)) return null;
    const wasStopped = this.stoppedReason !== null;
    const observedStop = this.observeUsage(runId, usage);
    this.accountedRuns.add(runId);

    if (!usage || usage.telemetry !== 'reported') {
      // A runtime that already emitted real provider usage is metered even if
      // its terminal row is momentarily stale during shutdown.
      if (this.observedUsage.has(runId)) return observedStop;
      this.missingUsage.add(runId);
      const reason =
        usage?.telemetry === 'unsupported'
          ? 'agent runtime cannot report token usage; aggregate review stopped to keep spending bounded'
          : 'agent run returned without token usage; aggregate review stopped to keep spending bounded';
      this.stop(reason);
      return wasStopped ? null : reason;
    }
    return wasStopped ? null : observedStop;
  }

  queuedIds(): readonly string[] {
    return [...this.queued];
  }

  runningIds(): readonly string[] {
    return [...this.running];
  }

  snapshot(): PrReviewBudgetProgress {
    const usage = [...this.observedUsage.values()];
    const inputTokens = usage.reduce((total, run) => total + run.inputTokens, 0);
    const outputTokens = usage.reduce((total, run) => total + run.outputTokens, 0);
    const estimatedCostUsd = usage.reduce((total, run) => total + (run.estimatedCostUsd ?? 0), 0);
    const costPartial =
      this.missingUsage.size > 0 ||
      usage.some((run) => run.inputTokens + run.outputTokens > 0 && run.estimatedCostUsd === null);
    return {
      modelCalls: this.modelCalls,
      maxModelCalls: this.maxModelCalls,
      startedAt: this.startedAt,
      deadlineAt: this.deadlineAt,
      tokenUsage: {
        inputTokens,
        outputTokens,
        maxTokens: this.maxTokens,
        reportedRuns: this.observedUsage.size,
        missingRuns: this.missingUsage.size,
        estimatedCostUsd,
        costPartial,
      },
    };
  }

  private totalTokens(): number {
    let total = 0;
    for (const usage of this.observedUsage.values()) total += usage.inputTokens + usage.outputTokens;
    return total;
  }
}

function tokenCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : fallback;
}
