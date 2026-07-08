import { useCallback, useEffect, useState } from 'react';
import type { PipelineRecord, PrRecord, RepoRecord } from '@companion/contract';
import { api, onServerMessage } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { PAGE_SIZE, useDebounced, useInfiniteList } from '../lib/paging.js';
import { useHashParams } from '../lib/hashParams.js';
import type { ContextMenuState, MenuAction } from '../components/ui.js';

export type PrTab = 'open' | 'merged' | 'closed';

const FILTER_KEYS = ['repo', 'author', 'assignee', 'decision', 'review', 'draft'] as const;

/**
 * All of the Pull Requests list's business logic — URL-driven filters, the
 * server-paged infinite list, bulk selection + actions, and per-row quick
 * actions. The page is presentation over this.
 */
export interface UseWorkspacePrs {
  readonly tab: PrTab;
  readonly setTab: (t: PrTab) => void;
  readonly search: string;
  readonly setSearch: (s: string) => void;
  readonly filters: Record<(typeof FILTER_KEYS)[number], string>;
  readonly setFilter: (key: string) => (value: string) => void;
  readonly clearFilters: () => void;
  readonly activeFilters: number;

  readonly repos: RepoRecord[];
  readonly facets: { authors: string[]; assignees: string[] };
  readonly counts: { open: number; merged: number; closed: number };

  readonly prs: PrRecord[];
  readonly total: number;
  readonly loading: boolean;
  readonly hasMore: boolean;
  readonly loadMore: () => void;
  readonly error: string | null;

  readonly canActPrs: boolean;
  readonly canRunPipelines: boolean;
  readonly pipelines: PipelineRecord[];

  readonly selected: ReadonlySet<string>;
  readonly toggleSelected: (key: string) => void;
  readonly selectAllLoaded: () => void;
  readonly clearSelected: () => void;
  readonly bulkPipeline: string;
  readonly setBulkPipeline: (id: string) => void;
  readonly bulkRunning: string | null;
  readonly bulkAiReview: () => void;
  readonly bulkRunPipeline: () => void;

  readonly rowActions: (pr: PrRecord) => MenuAction[];
  readonly ctx: ContextMenuState | null;
  readonly setCtx: (c: ContextMenuState | null) => void;
  readonly flash: string | null;
  readonly bulkError: string | null;
}

export function useWorkspacePrs(workspaceId: string | undefined): UseWorkspacePrs {
  const { can } = useAuth();
  const [params, setParam] = useHashParams();
  const stateParam = params.get('state');
  const tab: PrTab = stateParam === 'merged' || stateParam === 'closed' ? stateParam : 'open';
  const setTab = (t: PrTab): void => setParam('state', t === 'open' ? null : t);
  useEffect(() => {
    sessionStorage.setItem('companion.tab:#/prs', tab);
  }, [tab]);

  const [search, setSearch] = useState(() => params.get('q') ?? '');
  const filters = {
    repo: params.get('repo') ?? 'all',
    author: params.get('author') ?? 'all',
    assignee: params.get('assignee') ?? 'all',
    decision: params.get('decision') ?? 'all',
    review: params.get('review') ?? 'all',
    draft: params.get('draft') ?? 'all',
  };
  const setFilter = (key: string) => (value: string) => setParam(key, value === 'all' ? null : value);
  const clearFilters = (): void => {
    for (const k of FILTER_KEYS) setParam(k, null);
  };
  useEffect(() => {
    const urlQ = params.get('q') ?? '';
    setSearch((s) => (s.trim() === urlQ ? s : urlQ));
  }, [params]);

  const [repos, setRepos] = useState<RepoRecord[]>([]);
  const [facets, setFacets] = useState<{ authors: string[]; assignees: string[] }>({ authors: [], assignees: [] });
  const [counts, setCounts] = useState<{ open: number; merged: number; closed: number }>({ open: 0, merged: 0, closed: 0 });

  useEffect(() => {
    if (!workspaceId) return;
    api
      .workspaceRepos(workspaceId)
      .then(({ repos }) => setRepos(repos))
      .catch(() => setRepos([]));
  }, [workspaceId]);

  const [pipelines, setPipelines] = useState<PipelineRecord[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulkPipeline, setBulkPipeline] = useState('');
  const [bulkRunning, setBulkRunning] = useState<string | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [ctx, setCtx] = useState<ContextMenuState | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const canRunPipelines = can('pipelines:run');
  const canActPrs = can('prs:act');

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 4000);
    return () => clearTimeout(t);
  }, [flash]);

  useEffect(() => {
    if (!workspaceId || !can('pipelines:read')) return;
    api
      .workspacePipelines(workspaceId)
      .then((r) => setPipelines(r.pipelines.filter((pl) => pl.type === 'pr')))
      .catch(() => setPipelines([]));
  }, [workspaceId, can]);

  useEffect(() => {
    setSelected(new Set());
  }, [tab, workspaceId]);

  const q = useDebounced(search.trim());
  useEffect(() => {
    setParam('q', q || null, { replace: true });
  }, [q, setParam]);

  const fetchPage = useCallback(
    async (offset: number) => {
      if (!workspaceId) return { items: [] as PrRecord[], total: 0 };
      const page = await api.workspacePrs(workspaceId, tab, {
        q: q || undefined,
        repo: filters.repo === 'all' ? undefined : filters.repo,
        author: filters.author === 'all' ? undefined : filters.author,
        assignee: filters.assignee === 'all' ? undefined : filters.assignee,
        decision: filters.decision === 'all' ? undefined : filters.decision,
        review: filters.review === 'all' ? undefined : filters.review,
        draft: filters.draft === 'all' ? undefined : filters.draft,
        limit: PAGE_SIZE,
        offset,
      });
      setCounts(page.counts);
      setFacets(page.facets);
      return { items: page.prs, total: page.total };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspaceId, tab, q, filters.repo, filters.author, filters.assignee, filters.decision, filters.review, filters.draft],
  );
  const { items: prs, total, loading, hasMore, loadMore, reload, error } = useInfiniteList(fetchPage);
  const activeFilters = FILTER_KEYS.map((k) => filters[k]).filter((f) => f !== 'all').length;

  useEffect(() => {
    return onServerMessage((msg) => {
      if (msg.t === 'prs.changed' || msg.t === 'pipelineRuns.changed') reload();
    });
  }, [reload]);

  const toggleSelected = (key: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const selectAllLoaded = (): void => setSelected(new Set(prs.map((pr) => `${pr.repo}#${pr.number}`)));
  const clearSelected = (): void => setSelected(new Set());

  const runBulkWith = async (fn: (pr: PrRecord) => Promise<unknown>, noun: string): Promise<void> => {
    if (selected.size === 0) return;
    const targets = prs.filter((pr) => selected.has(`${pr.repo}#${pr.number}`));
    const failures: string[] = [];
    for (let i = 0; i < targets.length; i++) {
      const pr = targets[i]!;
      setBulkRunning(`${i + 1}/${targets.length}`);
      try {
        await fn(pr);
      } catch {
        failures.push(`#${pr.number}`);
      }
    }
    setBulkRunning(null);
    setSelected(new Set());
    if (failures.length > 0) setBulkError(`Failed to start for ${failures.join(', ')}`);
    else setFlash(`${noun} started for ${targets.length} PR${targets.length === 1 ? '' : 's'}`);
  };
  const bulkAiReview = (): void => void runBulkWith((pr) => api.analyzePr(pr.repo, pr.number), 'AI review');
  const bulkRunPipeline = (): void => {
    if (!bulkPipeline) return;
    void runBulkWith((pr) => api.runPipeline(pr.repo, pr.number, bulkPipeline), 'Pipeline');
  };

  const quick = async (fn: () => Promise<unknown>, done: string): Promise<void> => {
    setBulkError(null);
    try {
      await fn();
      setFlash(done);
    } catch (err) {
      setBulkError(String(err));
    }
  };
  const rowActions = (pr: PrRecord): MenuAction[] => [
    ...(canActPrs && pr.state === 'open'
      ? [
          {
            label: 'Run AI review',
            onSelect: () => void quick(() => api.analyzePr(pr.repo, pr.number), `AI review queued for #${pr.number}`),
          },
        ]
      : []),
    ...(canRunPipelines && pr.state === 'open'
      ? pipelines.map((pl) => ({
          label: `Run pipeline: ${pl.name}`,
          onSelect: () => void quick(() => api.runPipeline(pr.repo, pr.number, pl.id), `${pl.name} started for #${pr.number}`),
        }))
      : []),
    { label: 'Open on GitHub', href: pr.url, external: true },
  ];

  return {
    tab,
    setTab,
    search,
    setSearch,
    filters,
    setFilter,
    clearFilters,
    activeFilters,
    repos,
    facets,
    counts,
    prs,
    total,
    loading,
    hasMore,
    loadMore,
    error,
    canActPrs,
    canRunPipelines,
    pipelines,
    selected,
    toggleSelected,
    selectAllLoaded,
    clearSelected,
    bulkPipeline,
    setBulkPipeline,
    bulkRunning,
    bulkAiReview,
    bulkRunPipeline,
    rowActions,
    ctx,
    setCtx,
    flash,
    bulkError,
  };
}
