import { useCallback, useEffect, useState } from 'react';
import { onServerMessage } from '@moxxy/companion-core/client';
import { PAGE_SIZE, useInfiniteList } from '@moxxy/companion-ui';
import type { RunListRecord, RunRecord } from '../../contract/index.js';
import { operateApi as api } from '../api.js';

export interface RunPageFilters {
  readonly workspaceId: string | undefined;
  readonly q?: string;
  readonly repo?: string;
  readonly kind?: string;
  readonly status?: string;
  readonly limit?: number;
}

/**
 * Server-paged maintainer queue. Run events can arrive several times per
 * second while agents stream, so they are coalesced to at most one list reload
 * per second; detail views keep consuming the unthrottled event stream.
 */
export function useRunsPage(filters: RunPageFilters): {
  /** null until the first page resolves. */
  runs: RunListRecord[] | null;
  total: number;
  loading: boolean;
  hasMore: boolean;
  loadMore: () => void;
  error: string | null;
  setError: (e: string | null) => void;
  refresh: () => void;
} {
  const [actionError, setError] = useState<string | null>(null);
  const fetchPage = useCallback(
    async (offset: number) => {
      if (!filters.workspaceId) return { items: [] as RunListRecord[], total: 0 };
      const page = await api.listRunsPage({
        workspace: filters.workspaceId,
        q: filters.q,
        repo: filters.repo,
        kind: filters.kind,
        status: filters.status,
        limit: filters.limit ?? PAGE_SIZE,
        offset,
      });
      return { items: page.runs, total: page.total };
    },
    [filters.workspaceId, filters.q, filters.repo, filters.kind, filters.status, filters.limit],
  );
  const { items, total, loading, hasMore, loadMore, reload, error: listError } = useInfiniteList(fetchPage);

  useEffect(() => {
    let timer: number | null = null;
    let lastReload = 0;
    const scheduleReload = (): void => {
      if (timer !== null) return;
      const delay = Math.max(0, 1_000 - (Date.now() - lastReload));
      timer = window.setTimeout(() => {
        timer = null;
        lastReload = Date.now();
        reload();
      }, delay);
    };
    const unsubscribe = onServerMessage((message) => {
      if (message.t === 'runs.changed' || message.t === 'run.changed') scheduleReload();
    });
    return () => {
      unsubscribe();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [reload]);

  return {
    runs: loading && items.length === 0 ? null : items,
    total,
    loading,
    hasMore,
    loadMore,
    error: actionError ?? listError,
    setError,
    refresh: reload,
  };
}

/**
 * The agent-run feed, kept live: a full reload on runs.changed and an in-place
 * patch (or prepend) on each run.changed. One concern; the error setter is
 * exposed for page-level actions (e.g. starting a run).
 */
export function useRuns(): {
  runs: RunRecord[];
  error: string | null;
  setError: (e: string | null) => void;
  refresh: () => Promise<void>;
} {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      const { runs } = await api.listRuns();
      setRuns(runs);
    } catch (err) {
      setError(String(err));
    }
  };

  useEffect(() => {
    void refresh();
    return onServerMessage((msg) => {
      if (msg.t === 'runs.changed') void refresh();
      if (msg.t === 'run.changed') {
        setRuns((prev) => {
          const i = prev.findIndex((r) => r.id === msg.run.id);
          if (i === -1) return [msg.run, ...prev];
          const next = [...prev];
          next[i] = msg.run;
          return next;
        });
      }
    });
  }, []);

  return { runs, error, setError, refresh };
}
