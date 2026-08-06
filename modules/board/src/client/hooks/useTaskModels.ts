import { useCallback, useState } from 'react';
import { useLive } from '@moxxy/companion-sdk/client';
import type { TaskModelOptions } from '../../contract/index.js';
import { boardApi } from '../api.js';

/**
 * What a card's model picker may offer and what "inherit" resolves to. Both
 * move without anyone touching the board (a machine's catalog refreshes, an
 * admin repins board.worker), so this re-reads on those events rather than
 * caching a snapshot for the session.
 *
 * `enabled` is false for viewers without board:manage: the route is theirs
 * alone, and fetching it anyway would 403 on every board render.
 */
export function useTaskModels(enabled: boolean): TaskModelOptions | null {
  const [options, setOptions] = useState<TaskModelOptions | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      setOptions(await boardApi.models());
    } catch {
      // A picker that cannot list models still renders: the card keeps whatever
      // it already holds, and "inherit" stays selectable.
      setOptions((prev) => prev ?? EMPTY);
    }
  }, [enabled]);

  useLive(refresh, (msg) => msg.t === 'runners.changed' || msg.t === 'task-models.changed');

  return options;
}

const EMPTY: TaskModelOptions = { models: [], workerModel: null };
