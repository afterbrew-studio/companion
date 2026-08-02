import type { PlaygroundProductionSuiteBudget } from '../contract/index.js';

export const MAX_PRODUCTION_SUITE_TOKENS = 1_000_000;
export const MAX_PRODUCTION_SUITE_WALL_MS = 60 * 60_000;

export interface ProductionSuiteRunUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number | null;
  readonly telemetry: 'reported' | 'missing' | 'unsupported';
}

/** Monotonic aggregate guard over every model turn in one release-gate suite. */
export class ProductionSuiteBudgetGuard {
  readonly startedAt: number;
  readonly deadlineAt: number;
  readonly maxTokens: number;

  private readonly now: () => number;
  private stopReason: string | null = null;
  private readonly observed = new Map<string, ProductionSuiteRunUsage>();
  private readonly settled = new Set<string>();
  private readonly missing = new Set<string>();

  constructor(opts: {
    readonly maxTokens?: number;
    readonly wallMs?: number;
    readonly now?: () => number;
  } = {}) {
    this.now = opts.now ?? Date.now;
    this.maxTokens = positiveInt(opts.maxTokens, MAX_PRODUCTION_SUITE_TOKENS);
    this.startedAt = this.now();
    this.deadlineAt = this.startedAt + positiveInt(opts.wallMs, MAX_PRODUCTION_SUITE_WALL_MS);
  }

  timeoutFor(requestedMs: number): number {
    const remaining = this.deadlineAt - this.now();
    if (remaining <= 0) {
      const reason = 'production release gate time budget exhausted';
      this.stop(reason);
      throw new Error(reason);
    }
    return Math.max(1, Math.min(positiveInt(requestedMs, remaining), remaining));
  }

  stop(reason: string): void {
    this.stopReason ??= reason;
  }

  get stopped(): boolean {
    return this.stopReason !== null;
  }

  /** Fold cumulative provider events without charging duplicates or regressions. */
  observeUsage(runId: string, usage: ProductionSuiteRunUsage | null): string | null {
    if (this.settled.has(runId) || !usage || usage.telemetry !== 'reported') return null;
    const wasStopped = this.stopped;
    const previous = this.observed.get(runId);
    this.observed.set(runId, {
      inputTokens: Math.max(previous?.inputTokens ?? 0, tokenCount(usage.inputTokens)),
      outputTokens: Math.max(previous?.outputTokens ?? 0, tokenCount(usage.outputTokens)),
      estimatedCostUsd: normalizedCost(usage.estimatedCostUsd, previous?.estimatedCostUsd ?? null),
      telemetry: 'reported',
    });
    if (this.totalTokens() >= this.maxTokens) {
      const reason = 'production release gate token budget exhausted';
      this.stop(reason);
      return wasStopped ? null : reason;
    }
    return null;
  }

  /** Reconcile one child once; missing usage stops the suite instead of claiming a blind limit. */
  recordUsage(runId: string, usage: ProductionSuiteRunUsage | null): string | null {
    if (this.settled.has(runId)) return null;
    const wasStopped = this.stopped;
    const observedReason = this.observeUsage(runId, usage);
    this.settled.add(runId);
    if (!usage || usage.telemetry !== 'reported') {
      if (this.observed.has(runId)) return observedReason;
      this.missing.add(runId);
      const reason = usage?.telemetry === 'unsupported'
        ? 'agent runtime cannot report token usage; release gate stopped to keep spending bounded'
        : 'agent run returned without token usage; release gate stopped to keep spending bounded';
      this.stop(reason);
      return wasStopped ? null : reason;
    }
    return wasStopped ? null : observedReason;
  }

  snapshot(): PlaygroundProductionSuiteBudget {
    const usage = [...this.observed.values()];
    const inputTokens = safeSum(usage.map((row) => row.inputTokens));
    const outputTokens = safeSum(usage.map((row) => row.outputTokens));
    return {
      startedAt: this.startedAt,
      deadlineAt: this.deadlineAt,
      maxTokens: this.maxTokens,
      inputTokens,
      outputTokens,
      reportedRuns: usage.length,
      missingRuns: this.missing.size,
      estimatedCostUsd: usage.reduce((total, row) => total + (row.estimatedCostUsd ?? 0), 0),
      costPartial: this.missing.size > 0
        || usage.some((row) => row.inputTokens + row.outputTokens > 0 && row.estimatedCostUsd === null),
    };
  }

  private totalTokens(): number {
    const snapshot = this.snapshot();
    return Math.min(Number.MAX_SAFE_INTEGER, snapshot.inputTokens + snapshot.outputTokens);
  }
}

function tokenCount(value: number): number {
  return Number.isFinite(value) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value))) : 0;
}

function safeSum(values: ReadonlyArray<number>): number {
  let total = 0;
  for (const value of values) total = Math.min(Number.MAX_SAFE_INTEGER, total + value);
  return total;
}

function normalizedCost(value: number | null, previous: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 ? Math.max(previous ?? 0, value) : previous;
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : fallback;
}
