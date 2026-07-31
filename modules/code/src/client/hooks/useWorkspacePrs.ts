import { useCallback, useEffect, useState } from 'react';
import { onServerMessage, readCached, useBulkRunner, writeCached } from '@moxxy/companion-sdk/client';
import { useAuth } from '@companion/module-core/client';
import { useWorkspace } from '@companion/module-workspace/client';
import type { WorkspaceRecord } from '@companion/module-workspace/contract';
import {
  PAGE_SIZE,
  useFlash,
  useHashFilters,
  useHashSearch,
  useHashTab,
  useInfiniteList,
  useSelection,
  type ContextMenuState,
  type MenuAction,
} from '@moxxy/companion-sdk/ui';
import type { PipelineRecord, PrRecord, RepoRecord, RepoSyncFailure } from '../../contract/index.js';
import { codeApi as api } from '../api.js';
import { useWorkspaceRepos } from './useWorkspaceRepos.js';
import { useWorkspacePipelines } from './useWorkspacePipelines.js';
import { useWorkspaceRefresh } from './useWorkspaceRefresh.js';

export type PrTab = 'open' | 'merged' | 'closed';

const TABS = ['open', 'merged', 'closed'] as const;
const FILTER_KEYS = ['repo', 'author', 'assignee', 'decision', 'review', 'draft'] as const;

/**
 * The Pull Requests list's business logic, composed from atomic hooks — hash
 * tab/filters/search, workspace repos + pipelines, bulk selection + runner,
 * flash — plus the server-paged fetch and per-row actions. The page is pure
 * presentation over this.
 */
export interface UseWorkspacePrs {
  readonly current: WorkspaceRecord | null;
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
  readonly unavailableRepos: readonly string[];
  readonly failedRepos: readonly RepoSyncFailure[];

  readonly canActPrs: boolean;
  readonly canRunPipelines: boolean;
  readonly pipelines: PipelineRecord[];

  readonly selected: ReadonlySet<string>;
  readonly toggleSelected: (key: string) => void;
  readonly selectAllLoaded: () => void;
  readonly clearSelected: () => void;
  readonly bulkRunning: string | null;
  readonly bulkAiReview: () => void;
  readonly bulkRunPipeline: (pipelineId: string) => void;
  readonly bulkLabel: (labels: string[]) => void;
  readonly bulkComment: (body: string) => void;
  readonly bulkClose: () => void;
  readonly bulkRerunChecks: () => void;

  readonly rowActions: (pr: PrRecord) => MenuAction[];
  readonly ctx: ContextMenuState | null;
  readonly setCtx: (c: ContextMenuState | null) => void;
  readonly flash: string | null;
  readonly bulkError: string | null;
}

const prKey = (pr: PrRecord): string => `${pr.repo}#${pr.number}`;

export function useWorkspacePrs(): UseWorkspacePrs {
  const { current } = useWorkspace();
  const workspaceId = current?.id;
  const { can } = useAuth();
  const canRunPipelines = can('pipelines:run');
  const canActPrs = can('prs:act');

  const [tab, setTab] = useHashTab(TABS, 'open', 'companion.tab:#/prs');
  const { filters, setFilter, clearFilters, activeFilters } = useHashFilters(FILTER_KEYS);
  const { search, setSearch, q } = useHashSearch();

  const repos = useWorkspaceRepos(workspaceId);
  const pipelines = useWorkspacePipelines(workspaceId, 'pr');
  const selection = useSelection(`${tab}:${workspaceId}`);
  const { flash, show } = useFlash();
  const { bulkRunning, bulkError, setBulkError, runBulk } = useBulkRunner();

  const [ctx, setCtx] = useState<ContextMenuState | null>(null);
  const [facets, setFacets] = useState<{ authors: string[]; assignees: string[] }>({ authors: [], assignees: [] });
  const [counts, setCounts] = useState<{ open: number; merged: number; closed: number }>({ open: 0, merged: 0, closed: 0 });

  // The retained first page is keyed by everything the query depends on, the
  // workspace included: the same tab under another workspace is another list.
  const listKey = `prs:${workspaceId ?? ''}:${tab}:${q}:${JSON.stringify(filters)}`;
  const seed = readCached<{ items: PrRecord[]; total: number }>(listKey);
  const retain = useCallback(
    (page: { items: PrRecord[]; total: number }) => writeCached(listKey, page),
    [listKey],
  );

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
  const { items: prs, total, loading, hasMore, loadMore, reload, error: listError } = useInfiniteList(fetchPage, { seed, onFirstPage: retain });

  useEffect(() => {
    return onServerMessage((msg) => {
      if (msg.t === 'prs.changed' || msg.t === 'pipelineRuns.changed') reload();
    });
  }, [reload]);
  const refresh = useWorkspaceRefresh(workspaceId, repos);
  const unavailable = new Set(refresh.unavailableRepos);
  const visiblePrs = prs.filter((pr) => !unavailable.has(pr.repo));

  const bulkAiReview = (): void => {
    const targets = visiblePrs.filter((pr) => selection.has(prKey(pr)));
    void runBulk(targets, (pr) => api.analyzePr(pr.repo, pr.number), {
      label: (pr) => `#${pr.number}`,
      onSettled: (total, failures) => {
        selection.clear();
        if (failures.length > 0) setBulkError(`Failed to start for ${failures.join(', ')}`);
        else show(`AI review started for ${total} PR${total === 1 ? '' : 's'}`);
      },
    });
  };
  const bulkRunPipeline = (pipelineId: string): void => {
    const name = pipelines.find((pl) => pl.id === pipelineId)?.name ?? 'Pipeline';
    const targets = visiblePrs.filter((pr) => selection.has(prKey(pr)));
    void runBulk(targets, (pr) => api.runPipeline(pr.repo, pr.number, pipelineId), {
      label: (pr) => `#${pr.number}`,
      onSettled: (total, failures) => {
        selection.clear();
        if (failures.length > 0) setBulkError(`Failed to start for ${failures.join(', ')}`);
        else show(`${name} started for ${total} PR${total === 1 ? '' : 's'}`);
      },
    });
  };

  /** The selection, as records, in the order the list shows them. */
  const targets = (): PrRecord[] => visiblePrs.filter((pr) => selection.has(prKey(pr)));

  /**
   * Every bulk action reports per item. Fifteen pull requests partially succeed
   * by nature, and one "done" would be a lie in both directions.
   */
  const bulkForEach = (
    fn: (pr: PrRecord) => Promise<unknown>,
    done: (n: number) => string,
  ): void => {
    void runBulk(targets(), fn, {
      label: (pr) => `#${pr.number}`,
      onSettled: (total, failures) => {
        selection.clear();
        // The list reloads on the broadcast these actions cause; no manual refresh.
        if (failures.length > 0) setBulkError(`Failed for ${failures.join(', ')}`);
        else show(done(total));
      },
    });
  };

  const bulkLabel = (labels: string[]): void =>
    bulkForEach(
      (pr) => api.labelPr(pr.repo, pr.number, labels),
      (n) => `Labelled ${n} PR${n === 1 ? '' : 's'}`,
    );
  const bulkComment = (body: string): void =>
    bulkForEach(
      (pr) => api.commentPr(pr.repo, pr.number, body),
      (n) => `Commented on ${n} PR${n === 1 ? '' : 's'}`,
    );
  const bulkClose = (): void =>
    bulkForEach(
      (pr) => api.closePr(pr.repo, pr.number),
      (n) => `Closed ${n} PR${n === 1 ? '' : 's'}`,
    );
  const bulkRerunChecks = (): void =>
    bulkForEach(
      (pr) => api.rerunChecks(pr.repo, pr.number, 'failed'),
      (n) => `Re-ran failed jobs on ${n} PR${n === 1 ? '' : 's'}`,
    );

  const quick = async (fn: () => Promise<unknown>, done: string): Promise<void> => {
    setBulkError(null);
    try {
      await fn();
      show(done);
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
    current,
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
    prs: visiblePrs,
    total,
    loading,
    hasMore,
    loadMore,
    error: listError ?? refresh.error,
    unavailableRepos: refresh.unavailableRepos,
    failedRepos: refresh.failedRepos,
    canActPrs,
    canRunPipelines,
    pipelines,
    selected: selection.selected,
    toggleSelected: selection.toggle,
    selectAllLoaded: () => selection.selectAll(visiblePrs.map(prKey)),
    clearSelected: selection.clear,
    bulkRunning,
    bulkAiReview,
    bulkRunPipeline,
    bulkLabel,
    bulkComment,
    bulkClose,
    bulkRerunChecks,
    rowActions,
    ctx,
    setCtx,
    flash,
    bulkError,
  };
}
