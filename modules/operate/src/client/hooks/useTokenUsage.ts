import { useCallback, useState } from 'react';
import { useLive } from '@companion/core/client';
import type { TokenUsage } from '../../contract/index.js';
import { operateApi as api } from '../api.js';

export interface TokenUsageState {
  /** null until the first successful load (skeleton state). */
  readonly usage: TokenUsage | null;
  /** Last load failure — surfaced on the card, never silently swallowed. */
  readonly error: string | null;
  readonly retry: () => void;
}

/**
 * Token spend for the dashboard cost analytics, kept live. run.changed fires
 * on every status/turn transition — exactly when a run's usage row has settled —
 * so the aggregates refresh without a per-token refetch storm. A failed load
 * keeps any previous data and surfaces the error: a silently hidden card is
 * indistinguishable from "no chart at all" (e.g. a fetch racing a daemon
 * restart used to blank the section until the next run happened to refresh it).
 */
export function useTokenUsage(): TokenUsageState {
  const [usage, setUsage] = useState<TokenUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async (): Promise<void> => {
    try {
      setUsage(await api.tokenUsage());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useLive(refresh, (msg) => msg.t === 'run.changed' || msg.t === 'runs.changed');
  const retry = useCallback(() => void refresh(), [refresh]);
  return { usage, error, retry };
}
