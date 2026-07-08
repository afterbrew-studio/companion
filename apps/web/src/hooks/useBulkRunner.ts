import { useState } from 'react';

export interface BulkRunner {
  /** "3/10" while a bulk run is in flight, else null. */
  readonly bulkRunning: string | null;
  readonly bulkError: string | null;
  readonly setBulkError: (e: string | null) => void;
  /**
   * Run `fn` over each target in sequence, tracking progress and collecting the
   * ones that threw. `label` names a target for the failure message; `onSettled`
   * fires once at the end (clear selection, flash success / surface failures).
   */
  readonly runBulk: <T>(
    targets: T[],
    fn: (t: T) => Promise<unknown>,
    opts: { label: (t: T) => string; onSettled: (total: number, failures: string[]) => void },
  ) => Promise<void>;
}

/**
 * Sequentially applies an action across a selection, with progress + error
 * state. Two pieces of state (progress, error); reused by every bulk toolbar.
 */
export function useBulkRunner(): BulkRunner {
  const [bulkRunning, setBulkRunning] = useState<string | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);

  const runBulk = async <T>(
    targets: T[],
    fn: (t: T) => Promise<unknown>,
    opts: { label: (t: T) => string; onSettled: (total: number, failures: string[]) => void },
  ): Promise<void> => {
    if (targets.length === 0) return;
    setBulkError(null);
    const failures: string[] = [];
    for (let i = 0; i < targets.length; i++) {
      setBulkRunning(`${i + 1}/${targets.length}`);
      try {
        await fn(targets[i]!);
      } catch {
        failures.push(opts.label(targets[i]!));
      }
    }
    setBulkRunning(null);
    opts.onSettled(targets.length, failures);
  };

  return { bulkRunning, bulkError, setBulkError, runBulk };
}
