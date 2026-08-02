import { useCallback, useEffect, useRef, useState } from 'react';
import { onServerMessage } from '@moxxy/companion-sdk/client';
import { PAGE_SIZE, useDebounced, useInfiniteList } from '@moxxy/companion-sdk/ui';
import { useWorkspace } from '@companion/module-workspace/client';
import { useWorkspaceRepos } from '@companion/module-code/client';
import type { RepoRecord } from '@companion/module-code/contract';
import type { WorkspaceRecord } from '@companion/module-workspace/contract';
import type { AreaStorageState, DocListRecord } from '../../contract/index.js';
import { planApi as api } from '../api.js';

export interface DocListFilters {
  readonly repo: string;
  readonly source: string;
  readonly storage: string;
}

const EMPTY_FILTERS: DocListFilters = { repo: 'all', source: 'all', storage: 'all' };

/**
 * Server-paged documentation cards. Full markdown is deliberately absent from
 * this hook and is fetched by the card only when somebody reads or edits it.
 */
export interface UseDocs {
  readonly current: WorkspaceRecord | null;
  readonly repos: RepoRecord[];
  /** null only while the first page is unresolved. */
  readonly docs: DocListRecord[] | null;
  readonly total: number;
  readonly loading: boolean;
  readonly hasMore: boolean;
  readonly loadMore: () => void;
  readonly search: string;
  readonly setSearch: (value: string) => void;
  readonly filters: DocListFilters;
  readonly setFilter: (key: keyof DocListFilters) => (value: string) => void;
  readonly clearFilters: () => void;
  readonly activeFilters: number;
  readonly storage: AreaStorageState | null;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
}

export function useDocs(): UseDocs {
  const { current } = useWorkspace();
  const workspaceId = current?.id;
  const repos = useWorkspaceRepos(workspaceId);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<DocListFilters>(EMPTY_FILTERS);
  const [storage, setStorage] = useState<AreaStorageState | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const storageSeq = useRef(0);
  const q = useDebounced(search.trim());

  const fetchPage = useCallback(
    async (offset: number) => {
      if (!workspaceId) return { items: [] as DocListRecord[], total: 0 };
      const page = await api.workspaceDocs(workspaceId, {
        q: q || undefined,
        repo: filters.repo === 'all' ? undefined : filters.repo,
        source: filters.source === 'all' ? undefined : filters.source,
        storage: filters.storage === 'all' ? undefined : filters.storage,
        limit: PAGE_SIZE,
        offset,
      });
      return { items: page.docs, total: page.total };
    },
    [workspaceId, q, filters.repo, filters.source, filters.storage],
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
      const next = await api.docsConfig(workspaceId);
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
      if (msg.t !== 'docs.changed') return;
      list.reload();
      void refreshStorage();
    });
  }, [list.reload, refreshStorage]);

  const setFilter = useCallback(
    (key: keyof DocListFilters) => (value: string) => setFilters((prev) => ({ ...prev, [key]: value })),
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
    docs: list.loading && list.items.length === 0 ? null : list.items,
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
