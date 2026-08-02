import { useCallback, useEffect, useState } from 'react';
import { ApiError, onServerMessage } from '@moxxy/companion-sdk/client';
import { PAGE_SIZE, useInfiniteList } from '@moxxy/companion-sdk/ui';
import { useWorkspace } from '@companion/module-workspace/client';
import type { FeaturePlanningSessionSummary, PlannerSessionDetail } from '../../contract/index.js';
import { ideasApi } from '../api.js';

export function useIdeas(id?: string): {
  sessions: FeaturePlanningSessionSummary[] | null;
  detail: PlannerSessionDetail | null;
  legacyActiveCount: number;
  total: number;
  loading: boolean;
  hasMore: boolean;
  loadMore: () => void;
  missing: boolean;
  error: string | null;
  setError: (error: string | null) => void;
  refresh: () => Promise<void>;
} {
  const { current } = useWorkspace();
  const [detail, setDetail] = useState<PlannerSessionDetail | null>(null);
  const [legacyActiveCount, setLegacyActiveCount] = useState(0);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(async (offset: number) => {
    if (!current || id) return { items: [] as FeaturePlanningSessionSummary[], total: 0 };
    const result = await ideasApi.list(current.id, PAGE_SIZE, offset);
    setLegacyActiveCount(result.legacyActiveCount);
    return { items: result.sessions, total: result.total };
  }, [current, id]);
  const list = useInfiniteList(fetchPage);

  const refreshDetail = useCallback(async () => {
    if (!current || !id) return;
    try {
      setDetail(await ideasApi.get(id));
      setMissing(false);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setMissing(true);
      else setError(String(err));
    }
  }, [current, id]);

  useEffect(() => {
    if (id) void refreshDetail();
    return onServerMessage((message) => {
      if (message.t !== 'planner.changed') return;
      if (id) void refreshDetail();
      else list.reload();
    });
  }, [id, refreshDetail, list.reload]);

  const refresh = useCallback(async () => {
    if (id) await refreshDetail();
    else list.reload();
  }, [id, list.reload, refreshDetail]);
  const sessions = id || (list.loading && list.items.length === 0) ? null : list.items;
  return {
    sessions,
    detail,
    legacyActiveCount,
    total: list.total,
    loading: id ? detail === null && !missing : list.loading,
    hasMore: list.hasMore,
    loadMore: list.loadMore,
    missing,
    error: error ?? list.error,
    setError,
    refresh,
  };
}
