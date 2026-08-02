import { useCallback, useEffect, useRef, useState } from 'react';
import { onServerMessage } from '@moxxy/companion-sdk/client';
import { PAGE_SIZE, useDebounced, useInfiniteList } from '@moxxy/companion-sdk/ui';
import { useWorkspace } from '@companion/module-workspace/client';
import { useWorkspaceRepos } from '@companion/module-code/client';
import type { RepoRecord } from '@companion/module-code/contract';
import type { WorkspaceRecord } from '@companion/module-workspace/contract';
import type { AreaStorageState, SpecListRecord } from '../../contract/index.js';
import { planApi as api } from '../api.js';

export interface SpecListFilters {
  readonly repo: string;
  readonly status: string;
  readonly source: string;
  readonly storage: string;
}

const EMPTY_FILTERS: SpecListFilters = { repo: 'all', status: 'all', source: 'all', storage: 'all' };

/** Lightweight, server-filtered specification cards with bounded paging. */
export interface UseSpecs {
  readonly current: WorkspaceRecord | null;
  readonly repos: RepoRecord[];
  /** null only while the first page is unresolved. */
  readonly specs: SpecListRecord[] | null;
  readonly total: number;
  readonly loading: boolean;
  readonly hasMore: boolean;
  readonly loadMore: () => void;
  readonly search: string;
  readonly setSearch: (value: string) => void;
  readonly filters: SpecListFilters;
  readonly setFilter: (key: keyof SpecListFilters) => (value: string) => void;
  readonly clearFilters: () => void;
  readonly activeFilters: number;
  readonly storage: AreaStorageState | null;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
}

export function useSpecs(): UseSpecs {
  const { current } = useWorkspace();
  const workspaceId = current?.id;
  const repos = useWorkspaceRepos(workspaceId);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<SpecListFilters>(EMPTY_FILTERS);
  const [storage, setStorage] = useState<AreaStorageState | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const storageSeq = useRef(0);
  const q = useDebounced(search.trim());

  const fetchPage = useCallback(
    async (offset: number) => {
      if (!workspaceId) return { items: [] as SpecListRecord[], total: 0 };
      const page = await api.workspaceSpecs(workspaceId, {
        q: q || undefined,
        repo: filters.repo === 'all' ? undefined : filters.repo,
        status: filters.status === 'all' ? undefined : filters.status,
        source: filters.source === 'all' ? undefined : filters.source,
        storage: filters.storage === 'all' ? undefined : filters.storage,
        limit: PAGE_SIZE,
        offset,
      });
      return { items: page.specs, total: page.total };
    },
    [workspaceId, q, filters.repo, filters.status, filters.source, filters.storage],
  );
  const list = useInfiniteList(fetchPage);

  const refreshStorage = useCallback(async () => {
    const mySeq = ++storageSeq.current;
    if (!workspaceId) {
      setStorage(null);
      setStorageError(null);
      return;
    }
    try {
      const next = await api.specsConfig(workspaceId);
      if (storageSeq.current !== mySeq) return;
      setStorage(next);
      setStorageError(null);
    } catch (err) {
      if (storageSeq.current !== mySeq) return;
      setStorageError(err instanceof Error ? err.message : String(err));
    }
  }, [workspaceId]);

  useEffect(() => {
    setSearch('');
    setFilters(EMPTY_FILTERS);
    setStorage(null);
    void refreshStorage();
    return () => {
      storageSeq.current += 1;
    };
  }, [workspaceId, refreshStorage]);

  useEffect(() => {
    return onServerMessage((msg) => {
      if (msg.t !== 'specs.changed') return;
      list.reload();
      void refreshStorage();
    });
  }, [list.reload, refreshStorage]);

  const setFilter = useCallback(
    (key: keyof SpecListFilters) => (value: string) => setFilters((prev) => ({ ...prev, [key]: value })),
    [],
  );
  const clearFilters = useCallback(() => setFilters(EMPTY_FILTERS), []);
  const refresh = useCallback(async () => {
    list.reload();
    await refreshStorage();
  }, [list.reload, refreshStorage]);

  return {
    current,
    repos,
    specs: list.loading && list.items.length === 0 ? null : list.items,
    total: list.total,
    loading: list.loading,
    hasMore: list.hasMore,
    loadMore: list.loadMore,
    search,
    setSearch,
    filters,
    setFilter,
    clearFilters,
    activeFilters: Object.values(filters).filter((value) => value !== 'all').length,
    storage,
    error: list.error ?? storageError,
    refresh,
  };
}
