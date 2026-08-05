import { useCallback, useEffect, useRef, useState } from 'react';
import { useLive } from '@moxxy/companion-sdk/client';
import type { PreparedWorkbenchAction } from '../../contract/index.js';
import { workbenchApi } from '../api.js';

/** One owner-scoped live feed; payload-free WS messages only trigger a bounded refetch. */
export interface WorkbenchActionsFeed {
  readonly actions: readonly PreparedWorkbenchAction[];
  readonly loaded: boolean;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
}

export function useWorkbenchActions(workspaceId?: string, enabled = true): WorkbenchActionsFeed {
  const [actions, setActions] = useState<readonly PreparedWorkbenchAction[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);

  useEffect(() => {
    sequence.current += 1;
    setActions([]);
    setLoaded(false);
    setError(null);
    return () => {
      sequence.current += 1;
    };
  }, [workspaceId, enabled]);

  const refresh = useCallback(async () => {
    const requestId = ++sequence.current;
    if (!enabled) {
      setActions([]);
      setError(null);
      setLoaded(true);
      return;
    }
    try {
      const result = await workbenchApi.actions(workspaceId, 'pending');
      if (sequence.current !== requestId) return;
      setActions(result.actions);
      setError(null);
    } catch (err) {
      if (sequence.current !== requestId) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (sequence.current === requestId) setLoaded(true);
    }
  }, [workspaceId, enabled]);

  useEffect(() => {
    if (actions.length === 0) return;
    const nearest = Math.min(...actions.map((action) => action.expiresAt));
    const timer = window.setTimeout(() => void refresh(), Math.max(0, nearest - Date.now()) + 100);
    return () => window.clearTimeout(timer);
  }, [actions, refresh]);

  useLive(refresh, (msg) => msg.t === 'workbench.actions.changed' || msg.t === 'modules.changed');
  return { actions, loaded, error, refresh };
}
