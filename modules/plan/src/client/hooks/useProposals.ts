import { useCallback, useEffect, useState } from 'react';
import { onServerMessage } from '@moxxy/companion-sdk/client';
import { PAGE_SIZE, useDebounced, useInfiniteList } from '@moxxy/companion-sdk/ui';
import { useWorkspace } from '@companion/module-workspace/client';
import { useWorkspaceRepos } from '@companion/module-code/client';
import type { RepoRecord } from '@companion/module-code/contract';
import type { WorkspaceRecord } from '@companion/module-workspace/contract';
import type { ProposalListRecord } from '../../contract/index.js';
import { planApi as api } from '../api.js';

export interface ProposalListFilters {
  readonly repo: string;
  readonly status: string;
}

const EMPTY_FILTERS: ProposalListFilters = { repo: 'all', status: 'all' };

export interface UseProposals {
  readonly current: WorkspaceRecord | null;
  readonly repos: RepoRecord[];
  readonly proposals: ProposalListRecord[] | null;
  readonly total: number;
  readonly loading: boolean;
  readonly hasMore: boolean;
  readonly loadMore: () => void;
  readonly search: string;
  readonly setSearch: (value: string) => void;
  readonly filters: ProposalListFilters;
  readonly setFilter: (key: keyof ProposalListFilters) => (value: string) => void;
  readonly clearFilters: () => void;
  readonly activeFilters: number;
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
}

export function useProposals(): UseProposals {
  const { current } = useWorkspace();
  const workspaceId = current?.id;
  const repos = useWorkspaceRepos(workspaceId);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<ProposalListFilters>(EMPTY_FILTERS);
  const q = useDebounced(search.trim());

  const fetchPage = useCallback(async (offset: number) => {
    if (!workspaceId) return { items: [] as ProposalListRecord[], total: 0 };
    const page = await api.workspaceProposals(workspaceId, {
      q: q || undefined,
      repo: filters.repo === 'all' ? undefined : filters.repo,
      status: filters.status === 'all' ? undefined : filters.status,
      limit: PAGE_SIZE,
      offset,
    });
    return { items: page.proposals, total: page.total };
  }, [workspaceId, q, filters.repo, filters.status]);
  const list = useInfiniteList(fetchPage);

  useEffect(() => {
    setSearch('');
    setFilters(EMPTY_FILTERS);
  }, [workspaceId]);

  useEffect(() => onServerMessage((message) => {
    if (message.t === 'proposals.changed') list.reload();
  }), [list.reload]);

  const setFilter = useCallback(
    (key: keyof ProposalListFilters) => (value: string) => setFilters((prev) => ({ ...prev, [key]: value })),
    [],
  );
  const clearFilters = useCallback(() => setFilters(EMPTY_FILTERS), []);
  const refresh = useCallback(async () => {
    list.reload();
  }, [list.reload]);

  return {
    current,
    repos,
    proposals: list.loading && list.items.length === 0 ? null : list.items,
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
    error: list.error,
    refresh,
  };
}
