import { useCallback, useEffect, useRef, useState } from 'react';
import { readCached, useLive, writeCached } from '@moxxy/companion-sdk/client';
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
  const cacheKey = workspaceId ? `workbench:decisions:${workspaceId}` : null;
  const retained = cacheKey === null
    ? null
    : readCached<{ readonly items: readonly DecisionItem[]; readonly hasMore: boolean }>(cacheKey);
  const [items, setItems] = useState<readonly DecisionItem[]>(retained?.items ?? []);
  const [hasMore, setHasMore] = useState(retained?.hasMore ?? false);
  const [snapshotWorkspace, setSnapshotWorkspace] = useState<string | null>(retained ? (workspaceId ?? null) : null);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);

  // Never render one workspace's decisions under another workspace's name.
  useEffect(() => {
    sequence.current += 1;
    const snapshot = cacheKey === null
      ? null
      : readCached<{ readonly items: readonly DecisionItem[]; readonly hasMore: boolean }>(cacheKey);
    setItems(snapshot?.items ?? []);
    setHasMore(snapshot?.hasMore ?? false);
    setSnapshotWorkspace(snapshot ? (workspaceId ?? null) : null);
    setError(null);
  }, [workspaceId, cacheKey]);

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
      if (cacheKey !== null) writeCached(cacheKey, snapshot);
      setItems(snapshot.items);
      setHasMore(snapshot.hasMore);
      setSnapshotWorkspace(workspaceId);
      setError(null);
    } catch (err) {
      if (sequence.current !== requestId) return;
      setError(err instanceof Error ? err.message : String(err));
      setSnapshotWorkspace(workspaceId);
    }
  }, [workspaceId, cacheKey]);

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

  const current = snapshotWorkspace === workspaceId
    ? { items, hasMore, loaded: true }
    : { items: retained?.items ?? [], hasMore: retained?.hasMore ?? false, loaded: retained !== null };
  return {
    items: current.items,
    hasMore: current.hasMore,
    loaded: workspaceId === undefined || current.loaded,
    error: snapshotWorkspace === workspaceId ? error : null,
    refresh,
  };
}
