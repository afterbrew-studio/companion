import { useCallback, useState } from 'react';
import { useLive } from '@companion/core/client';
import type { RunnerCapacitySnapshot } from '../../contract/index.js';
import { operateApi as api } from '../api.js';

const EMPTY: RunnerCapacitySnapshot = { active: 0, capacity: 1 };

/** Shared + private runner occupancy for the signed-in viewer, kept live. */
export function useRunnerCapacity(): RunnerCapacitySnapshot {
  const [snapshot, setSnapshot] = useState<RunnerCapacitySnapshot>(EMPTY);
  const refresh = useCallback(async () => {
    try {
      setSnapshot(await api.runnerCapacity());
    } catch {
      setSnapshot(EMPTY);
    }
  }, []);
  useLive(
    refresh,
    (msg) => msg.t === 'run.changed' || msg.t === 'runs.changed' || msg.t === 'runners.changed',
  );
  return snapshot;
}
