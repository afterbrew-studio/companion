import { MAX_PIPELINE_STEP_LOG_CHARS, type PipelineStepLog, type PipelineStepResult } from '../contract/index.js';

/** Pure bounded fold shared by live execution and its limit tests. */
export function appendPipelineStepLog(
  previous: PipelineStepLog | null | undefined,
  chunk: string,
  updatedAt = Date.now(),
  maxChars = MAX_PIPELINE_STEP_LOG_CHARS,
): PipelineStepLog {
  const combined = (previous?.text ?? '') + chunk;
  const limit = Math.max(1, Math.floor(maxChars));
  const clipped = combined.length > limit;
  return {
    text: clipped ? combined.slice(-limit) : combined,
    sequence: (previous?.sequence ?? 0) + 1,
    truncated: (previous?.truncated ?? false) || clipped,
    updatedAt,
  };
}

type CancelEffect = () => void | Promise<void>;

/**
 * In-memory control plane for one durable pipeline row.
 *
 * SQLite remains the lifecycle truth. This object only owns things a process
 * can control while alive: an AbortSignal, queued/running child cleanup, and a
 * latest step snapshot so cancellation does not lose the last throttled log.
 */
export class PipelineExecution {
  private readonly controller = new AbortController();
  private readonly cancelEffects = new Set<CancelEffect>();
  private snapshotProvider: (() => ReadonlyArray<PipelineStepResult>) | null = null;
  private stoppedReason: string | null = null;
  private stopping: Promise<void> | null = null;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get stopped(): boolean {
    return this.stoppedReason !== null;
  }

  bindSnapshot(provider: () => ReadonlyArray<PipelineStepResult>): void {
    this.snapshotProvider = provider;
  }

  snapshot(): ReadonlyArray<PipelineStepResult> | undefined {
    return this.snapshotProvider?.();
  }

  /** Register active cleanup; a late registration is cancelled immediately. */
  onCancel(effect: CancelEffect): () => void {
    if (this.stopped) {
      void Promise.resolve().then(effect).catch(() => undefined);
      return () => undefined;
    }
    this.cancelEffects.add(effect);
    return () => this.cancelEffects.delete(effect);
  }

  /** Idempotent: every registered child is stopped at most once. */
  async stop(reason: string): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stoppedReason = reason;
    this.controller.abort(reason);
    const effects = [...this.cancelEffects];
    this.cancelEffects.clear();
    this.stopping = Promise.allSettled(effects.map((effect) => Promise.resolve().then(effect))).then(() => undefined);
    return this.stopping;
  }
}
