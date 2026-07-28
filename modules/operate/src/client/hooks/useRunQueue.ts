import { useCallback, useState } from 'react';
import { useLive } from '@moxxy/companion-core/client';
import type { RunQueueSnapshot } from '../../contract/index.js';
import { operateApi as api } from '../api.js';

const EMPTY: RunQueueSnapshot = { active: 0, capacity: 1, entries: [] };

/**
 * The run scheduler's live state — running count, combined runner capacity, and
 * the waiting line — kept fresh on every queue.changed. Drives the header
 * "runners busy" indicator and the queue panel.
 */
export function useRunQueue(): RunQueueSnapshot {
  const [queue, setQueue] = useState<RunQueueSnapshot>(EMPTY);
  const refresh = useCallback(async () => {
    try {
      const { queue } = await api.runQueue();
      setQueue(queue);
    } catch {
      setQueue(EMPTY);
    }
  }, []);
  useLive(refresh, (msg) => msg.t === 'queue.changed' || msg.t === 'run.changed' || msg.t === 'runs.changed');
  return queue;
}
