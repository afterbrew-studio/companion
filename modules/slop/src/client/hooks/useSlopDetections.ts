import { useCallback, useEffect, useState } from 'react';
import { onServerMessage } from '@moxxy/companion-sdk/client';
import { PAGE_SIZE, useInfiniteList } from '@moxxy/companion-sdk/ui';
import { useWorkspace } from '@companion/module-workspace/client';
import type { WorkspaceRecord } from '@companion/module-workspace/contract';
import type { SlopDetectionResult } from '../../contract/index.js';
import { slopApi } from '../api.js';

/** The active workspace's detections, kept live over slop.changed. */
export function useSlopDetections(
  filters: { readonly q?: string; readonly repo?: string; readonly status?: string; readonly quality?: string } = {},
): {
  current: WorkspaceRecord | null;
  /** null until the first load resolves. */
  detections: SlopDetectionResult[] | null;
  total: number;
  loading: boolean;
  hasMore: boolean;
  loadMore: () => void;
  error: string | null;
  setError: (e: string | null) => void;
  refresh: () => Promise<void>;
} {
  const { current } = useWorkspace();
  const [actionError, setError] = useState<string | null>(null);

  const fetchPage = useCallback(
    async (offset: number) => {
      if (!current) return { items: [] as SlopDetectionResult[], total: 0 };
      const page = await slopApi.list(current.id, {
        ...filters,
        limit: PAGE_SIZE,
        offset,
      });
      return { items: page.detections, total: page.total };
    },
    [current, filters.q, filters.repo, filters.status, filters.quality],
  );
  const { items, total, loading, hasMore, loadMore, reload, error: listError } = useInfiniteList(fetchPage);

  useEffect(
    () => onServerMessage((message) => {
      if (message.t === 'slop.changed') reload();
    }),
    [reload],
  );

  return {
    current,
    detections: loading && items.length === 0 ? null : items,
    total,
    loading,
    hasMore,
    loadMore,
    error: actionError ?? listError,
    setError,
    refresh: async () => reload(),
  };
}
