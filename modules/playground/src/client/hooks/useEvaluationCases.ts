import { useCallback, useRef, useState } from 'react';
import { useLive } from '@moxxy/companion-sdk/client';
import type {
  PlaygroundEvaluationSnapshot,
  PlaygroundProductionEvaluationSnapshot,
} from '../../contract/index.js';
import { playgroundApi } from '../api.js';

/** Single owner of the playground.changed refetch contract. */
export function useEvaluationCases(): {
  readonly snapshot: PlaygroundEvaluationSnapshot | null;
  readonly production: PlaygroundProductionEvaluationSnapshot | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
} {
  const [snapshot, setSnapshot] = useState<PlaygroundEvaluationSnapshot | null>(null);
  const [production, setProduction] = useState<PlaygroundProductionEvaluationSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const refreshAgain = useRef(false);

  const refresh = useCallback((): Promise<void> => {
    if (inFlight.current) {
      // Collapse any burst of phase broadcasts into one trailing snapshot.
      // This prevents older overlapping responses from regressing progress.
      refreshAgain.current = true;
      return inFlight.current;
    }
    const task = (async (): Promise<void> => {
      do {
        refreshAgain.current = false;
        try {
          const [customSnapshot, productionSnapshot] = await Promise.all([
            playgroundApi.evaluationCases(),
            playgroundApi.productionEvaluations(),
          ]);
          setSnapshot(customSnapshot);
          setProduction(productionSnapshot);
          setError(null);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setLoading(false);
        }
      } while (refreshAgain.current);
    })();
    inFlight.current = task;
    void task.finally(() => {
      if (inFlight.current === task) inFlight.current = null;
    });
    return task;
  }, []);

  useLive(refresh, (message) => message.t === 'playground.changed');

  return { snapshot, production, loading, error, refresh };
}
