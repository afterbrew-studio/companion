import { useCallback, useEffect, useRef, useState } from 'react';
import { readCached, useLive, writeCached } from '@moxxy/companion-sdk/client';
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
  const cacheKey = enabled ? `workbench:actions:${workspaceId ?? 'all'}` : null;
  const retained = cacheKey === null ? null : readCached<readonly PreparedWorkbenchAction[]>(cacheKey);
  const [actions, setActions] = useState<readonly PreparedWorkbenchAction[]>(retained ?? []);
  const [loaded, setLoaded] = useState(retained !== null);
  const [snapshotKey, setSnapshotKey] = useState<string | null>(cacheKey);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);

  useEffect(() => {
    sequence.current += 1;
    const snapshot = cacheKey === null ? null : readCached<readonly PreparedWorkbenchAction[]>(cacheKey);
    setActions(snapshot ?? []);
    setLoaded(!enabled || snapshot !== null);
    setSnapshotKey(cacheKey);
    setError(null);
    return () => {
      sequence.current += 1;
    };
  }, [workspaceId, enabled, cacheKey]);

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
      if (cacheKey !== null) writeCached(cacheKey, result.actions);
      setActions(result.actions);
      setError(null);
    } catch (err) {
      if (sequence.current !== requestId) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (sequence.current === requestId) {
        setSnapshotKey(cacheKey);
        setLoaded(true);
      }
    }
  }, [workspaceId, enabled, cacheKey]);

  const visibleActions = snapshotKey === cacheKey ? actions : (retained ?? []);
  const visibleLoaded = !enabled || (snapshotKey === cacheKey ? loaded : retained !== null);
  useEffect(() => {
    if (visibleActions.length === 0) return;
    const nearest = Math.min(...visibleActions.map((action) => action.expiresAt));
    const timer = window.setTimeout(() => void refresh(), Math.max(0, nearest - Date.now()) + 100);
    return () => window.clearTimeout(timer);
  }, [visibleActions, refresh]);

  useLive(refresh, (msg) => msg.t === 'workbench.actions.changed' || msg.t === 'modules.changed');
  return { actions: visibleActions, loaded: visibleLoaded, error: snapshotKey === cacheKey ? error : null, refresh };
}
