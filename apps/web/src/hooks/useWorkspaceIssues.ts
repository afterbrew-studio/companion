import { useCallback, useEffect, useState } from 'react';
import type { IssueRecord, PipelineRecord, RepoRecord } from '@companion/contract';
import { api, onServerMessage } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { PAGE_SIZE, useDebounced, useInfiniteList } from '../lib/paging.js';
import { useHashParams } from '../lib/hashParams.js';
import type { ContextMenuState, MenuAction } from '../components/ui.js';

export type IssueTab = 'open' | 'closed';

const FILTER_KEYS = ['repo', 'author', 'assignee', 'label', 'triage'] as const;

/**
 * All of the Issues list's business logic — URL-driven filters, the server-paged
 * infinite list, bulk selection + AI triage, and per-row quick actions. The page
 * is presentation over this.
 */
export interface UseWorkspaceIssues {
  readonly tab: IssueTab;
  readonly setTab: (t: IssueTab) => void;
  readonly search: string;
  readonly setSearch: (s: string) => void;
  readonly filters: Record<(typeof FILTER_KEYS)[number], string>;
  readonly setFilter: (key: string) => (value: string) => void;
  readonly clearFilters: () => void;
  readonly activeFilters: number;

  readonly repos: RepoRecord[];
  readonly facets: { authors: string[]; assignees: string[]; labels: string[] };
  readonly counts: { open: number; closed: number };

  readonly issues: IssueRecord[];
  readonly total: number;
  readonly loading: boolean;
  readonly hasMore: boolean;
  readonly loadMore: () => void;
  readonly error: string | null;

  readonly canActIssues: boolean;
  readonly canRunPipelines: boolean;
  readonly pipelines: PipelineRecord[];

  readonly selected: ReadonlySet<string>;
  readonly toggleSelected: (key: string) => void;
  readonly selectAllLoaded: () => void;
  readonly clearSelected: () => void;
  readonly bulkPipeline: string;
  readonly setBulkPipeline: (id: string) => void;
  readonly bulkRunning: string | null;
  readonly bulkAiTriage: () => void;
  readonly bulkRunPipeline: () => void;

  readonly rowActions: (issue: IssueRecord) => MenuAction[];
  readonly ctx: ContextMenuState | null;
  readonly setCtx: (c: ContextMenuState | null) => void;
  readonly flash: string | null;
  readonly bulkError: string | null;
}

export function useWorkspaceIssues(workspaceId: string | undefined): UseWorkspaceIssues {
  const { can } = useAuth();
  const [params, setParam] = useHashParams();
  const tab: IssueTab = params.get('state') === 'closed' ? 'closed' : 'open';
  const setTab = (t: IssueTab): void => setParam('state', t === 'open' ? null : t);
  useEffect(() => {
    sessionStorage.setItem('companion.tab:#/issues', tab);
  }, [tab]);

  const [search, setSearch] = useState(() => params.get('q') ?? '');
  const filters = {
    repo: params.get('repo') ?? 'all',
    author: params.get('author') ?? 'all',
    assignee: params.get('assignee') ?? 'all',
    label: params.get('label') ?? 'all',
    triage: params.get('triage') ?? 'all',
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
  const [facets, setFacets] = useState<{ authors: string[]; assignees: string[]; labels: string[] }>({
    authors: [],
    assignees: [],
    labels: [],
  });
  const [counts, setCounts] = useState<{ open: number; closed: number }>({ open: 0, closed: 0 });

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
  const canActIssues = can('issues:act');

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 4000);
    return () => clearTimeout(t);
  }, [flash]);

  useEffect(() => {
    if (!workspaceId || !can('pipelines:read')) return;
    api
      .workspacePipelines(workspaceId)
      .then((r) => setPipelines(r.pipelines.filter((pl) => pl.type === 'issue')))
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
      if (!workspaceId) return { items: [] as IssueRecord[], total: 0 };
      const page = await api.workspaceIssues(workspaceId, tab, {
        q: q || undefined,
        repo: filters.repo === 'all' ? undefined : filters.repo,
        author: filters.author === 'all' ? undefined : filters.author,
        assignee: filters.assignee === 'all' ? undefined : filters.assignee,
        label: filters.label === 'all' ? undefined : filters.label,
        triage: filters.triage === 'all' ? undefined : filters.triage,
        limit: PAGE_SIZE,
        offset,
      });
      setCounts(page.counts);
      setFacets(page.facets);
      return { items: page.issues, total: page.total };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspaceId, tab, q, filters.repo, filters.author, filters.assignee, filters.label, filters.triage],
  );
  const { items: issues, total, loading, hasMore, loadMore, reload, error } = useInfiniteList(fetchPage);
  const activeFilters = FILTER_KEYS.map((k) => filters[k]).filter((f) => f !== 'all').length;

  useEffect(() => {
    return onServerMessage((msg) => {
      if (msg.t === 'issues.changed' || msg.t === 'triage.changed') reload();
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
  const selectAllLoaded = (): void => setSelected(new Set(issues.map((i) => `${i.repo}#${i.number}`)));
  const clearSelected = (): void => setSelected(new Set());

  const runBulkWith = async (fn: (issue: IssueRecord) => Promise<unknown>, noun: string): Promise<void> => {
    if (selected.size === 0) return;
    const targets = issues.filter((i) => selected.has(`${i.repo}#${i.number}`));
    const failures: string[] = [];
    for (let i = 0; i < targets.length; i++) {
      const issue = targets[i]!;
      setBulkRunning(`${i + 1}/${targets.length}`);
      try {
        await fn(issue);
      } catch {
        failures.push(`#${issue.number}`);
      }
    }
    setBulkRunning(null);
    setSelected(new Set());
    if (failures.length > 0) setBulkError(`Failed to start for ${failures.join(', ')}`);
    else setFlash(`${noun} started for ${targets.length} issue${targets.length === 1 ? '' : 's'}`);
  };
  const bulkAiTriage = (): void => void runBulkWith((issue) => api.triageIssue(issue.repo, issue.number), 'Triage');
  const bulkRunPipeline = (): void => {
    if (!bulkPipeline) return;
    void runBulkWith((issue) => api.runPipelineOnIssue(issue.repo, issue.number, bulkPipeline), 'Pipeline');
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
  const rowActions = (issue: IssueRecord): MenuAction[] => [
    ...(canActIssues && issue.state === 'open'
      ? [
          {
            label: 'Run AI triage',
            onSelect: () => void quick(() => api.triageIssue(issue.repo, issue.number), `Triage queued for #${issue.number}`),
          },
          {
            label: 'Fix with agent',
            onSelect: () => void quick(() => api.fixIssue(issue.repo, issue.number), `Fix run started for #${issue.number}`),
          },
        ]
      : []),
    ...(canRunPipelines && issue.state === 'open'
      ? pipelines.map((pl) => ({
          label: `Run pipeline: ${pl.name}`,
          onSelect: () =>
            void quick(() => api.runPipelineOnIssue(issue.repo, issue.number, pl.id), `${pl.name} started for #${issue.number}`),
        }))
      : []),
    { label: 'Open on GitHub', href: issue.url, external: true },
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
    issues,
    total,
    loading,
    hasMore,
    loadMore,
    error,
    canActIssues,
    canRunPipelines,
    pipelines,
    selected,
    toggleSelected,
    selectAllLoaded,
    clearSelected,
    bulkPipeline,
    setBulkPipeline,
    bulkRunning,
    bulkAiTriage,
    bulkRunPipeline,
    rowActions,
    ctx,
    setCtx,
    flash,
    bulkError,
  };
}
