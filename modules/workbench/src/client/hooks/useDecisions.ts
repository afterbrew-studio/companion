import { useCallback, useEffect, useRef, useState } from 'react';
import { useLive } from '@moxxy/companion-sdk/client';
import type { DecisionItem } from '../../contract/index.js';
import { workbenchApi } from '../api.js';

/** The one live feed behind Today; foreign mutations only trigger a refetch. */
export function useDecisions(workspaceId: string | undefined): {
  readonly items: readonly DecisionItem[];
  readonly hasMore: boolean;
  readonly loaded: boolean;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
} {
  const [items, setItems] = useState<readonly DecisionItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [snapshotWorkspace, setSnapshotWorkspace] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);

  // Never render one workspace's decisions under another workspace's name.
  useEffect(() => {
    sequence.current += 1;
    setItems([]);
    setHasMore(false);
    setSnapshotWorkspace(null);
    setError(null);
  }, [workspaceId]);

  const refresh = useCallback(async () => {
    const requestId = ++sequence.current;
    if (!workspaceId) {
      setItems([]);
      setHasMore(false);
      setSnapshotWorkspace(null);
      setError(null);
      return;
    }
    try {
      const snapshot = await workbenchApi.decisions(workspaceId);
      if (sequence.current !== requestId) return;
      setItems(snapshot.items);
      setHasMore(snapshot.hasMore);
      setSnapshotWorkspace(workspaceId);
      setError(null);
    } catch (err) {
      if (sequence.current !== requestId) return;
      setError(err instanceof Error ? err.message : String(err));
      setSnapshotWorkspace(workspaceId);
    }
  }, [workspaceId]);

  useLive(
    refresh,
    (msg) =>
      msg.t === 'run.changed' ||
      msg.t === 'runs.changed' ||
      msg.t === 'repos.changed' ||
      msg.t === 'prs.changed' ||
      msg.t === 'issues.changed' ||
      msg.t === 'triage.changed' ||
      msg.t === 'board.changed' ||
      msg.t === 'modules.changed',
  );

  return {
    items,
    hasMore,
    loaded: workspaceId === undefined || snapshotWorkspace === workspaceId,
    error,
    refresh,
  };
}
