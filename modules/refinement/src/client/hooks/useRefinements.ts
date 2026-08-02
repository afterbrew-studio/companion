import { useCallback, useEffect } from 'react';
import { onServerMessage } from '@moxxy/companion-sdk/client';
import { PAGE_SIZE, useInfiniteList } from '@moxxy/companion-sdk/ui';
import { useWorkspace } from '@companion/module-workspace/client';
import type { WorkspaceRecord } from '@companion/module-workspace/contract';
import type { RefinementListEntry } from '../../contract/index.js';
import { refinementApi } from '../api.js';

/** The active workspace's refinements, kept live over refinement.changed. */
export function useRefinements(
  filters: { readonly q?: string; readonly repo?: string; readonly status?: string } = {},
): {
  current: WorkspaceRecord | null;
  /** null until the first load resolves. */
  refinements: RefinementListEntry[] | null;
  total: number;
  loading: boolean;
  hasMore: boolean;
  loadMore: () => void;
  error: string | null;
  refresh: () => void;
} {
  const { current } = useWorkspace();

  const fetchPage = useCallback(
    async (offset: number) => {
      if (!current) return { items: [] as RefinementListEntry[], total: 0 };
      const page = await refinementApi.list(current.id, { ...filters, limit: PAGE_SIZE, offset });
      return { items: page.refinements, total: page.total };
    },
    [current, filters.q, filters.repo, filters.status],
  );
  const { items, total, loading, hasMore, loadMore, reload, error } = useInfiniteList(fetchPage);

  useEffect(
    () => onServerMessage((message) => {
      if (message.t === 'refinement.changed') reload();
    }),
    [reload],
  );

  return {
    current,
    refinements: loading && items.length === 0 ? null : items,
    total,
    loading,
    hasMore,
    loadMore,
    error,
    refresh: reload,
  };
}
