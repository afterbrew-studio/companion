import { useCallback, useEffect, useState } from 'react';
import { onServerMessage, useBulkRunner } from '@moxxy/companion-sdk/client';
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
import type { IssueRecord, PipelineRecord, RepoRecord, RepoSyncFailure } from '../../contract/index.js';
import { codeApi as api } from '../api.js';
import { useWorkspaceRepos } from './useWorkspaceRepos.js';
import { useWorkspacePipelines } from './useWorkspacePipelines.js';
import { useWorkspaceRefresh } from './useWorkspaceRefresh.js';

export type IssueTab = 'open' | 'closed';

const TABS = ['open', 'closed'] as const;
const FILTER_KEYS = ['repo', 'author', 'assignee', 'label', 'triage'] as const;

/**
 * The Issues list's business logic, composed from atomic hooks — hash
 * tab/filters/search, workspace repos + pipelines, bulk selection + runner,
 * flash — plus the server-paged fetch and per-row actions. The page is pure
 * presentation over this.
 */
export interface UseWorkspaceIssues {
  readonly current: WorkspaceRecord | null;
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
  readonly unavailableRepos: readonly string[];
  readonly failedRepos: readonly RepoSyncFailure[];

  readonly canActIssues: boolean;
  readonly canRunPipelines: boolean;
  readonly pipelines: PipelineRecord[];

  readonly selected: ReadonlySet<string>;
  readonly toggleSelected: (key: string) => void;
  readonly selectAllLoaded: () => void;
  readonly clearSelected: () => void;
  readonly bulkRunning: string | null;
  readonly bulkAiTriage: () => void;
  readonly bulkRunPipeline: (pipelineId: string) => void;
  readonly bulkLabel: (labels: string[]) => void;
  readonly bulkComment: (body: string) => void;
  readonly bulkClose: () => void;

  readonly rowActions: (issue: IssueRecord) => MenuAction[];
  readonly ctx: ContextMenuState | null;
  readonly setCtx: (c: ContextMenuState | null) => void;
  readonly flash: string | null;
  readonly bulkError: string | null;
}

const issueKey = (i: IssueRecord): string => `${i.repo}#${i.number}`;

export function useWorkspaceIssues(): UseWorkspaceIssues {
  const { current } = useWorkspace();
  const workspaceId = current?.id;
  const { can } = useAuth();
  const canRunPipelines = can('pipelines:run');
  const canActIssues = can('issues:act');

  const [tab, setTab] = useHashTab(TABS, 'open', 'companion.tab:#/issues');
  const { filters, setFilter, clearFilters, activeFilters } = useHashFilters(FILTER_KEYS);
  const { search, setSearch, q } = useHashSearch();

  const repos = useWorkspaceRepos(workspaceId);
  const pipelines = useWorkspacePipelines(workspaceId, 'issue');
  const selection = useSelection(`${tab}:${workspaceId}`);
  const { flash, show } = useFlash();
  const { bulkRunning, bulkError, setBulkError, runBulk } = useBulkRunner();

  const [ctx, setCtx] = useState<ContextMenuState | null>(null);
  const [facets, setFacets] = useState<{ authors: string[]; assignees: string[]; labels: string[] }>({
    authors: [],
    assignees: [],
    labels: [],
  });
  const [counts, setCounts] = useState<{ open: number; closed: number }>({ open: 0, closed: 0 });

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
  const { items: issues, total, loading, hasMore, loadMore, reload, error: listError } = useInfiniteList(fetchPage);

  useEffect(() => {
    return onServerMessage((msg) => {
      if (msg.t === 'issues.changed' || msg.t === 'triage.changed') reload();
    });
  }, [reload]);
  const refresh = useWorkspaceRefresh(workspaceId, repos);
  const unavailable = new Set(refresh.unavailableRepos);
  const visibleIssues = issues.filter((issue) => !unavailable.has(issue.repo));

  /**
   * Every bulk action reports per item. A selection partially succeeds by
   * nature, and one "done" would be a lie in both directions.
   */
  const bulkForEach = (fn: (i: IssueRecord) => Promise<unknown>, done: (n: number) => string): void => {
    void runBulk(
      visibleIssues.filter((i) => selection.has(issueKey(i))),
      fn,
      {
        label: (i) => `#${i.number}`,
        onSettled: (total, failures) => {
          selection.clear();
          if (failures.length > 0) setBulkError(`Failed for ${failures.join(', ')}`);
          else show(done(total));
        },
      },
    );
  };

  const bulkLabel = (labels: string[]): void =>
    bulkForEach(
      (i) => api.labelIssue(i.repo, i.number, labels),
      (n) => `Labelled ${n} issue${n === 1 ? '' : 's'}`,
    );
  const bulkComment = (body: string): void =>
    bulkForEach(
      (i) => api.commentIssue(i.repo, i.number, body),
      (n) => `Commented on ${n} issue${n === 1 ? '' : 's'}`,
    );
  const bulkClose = (): void =>
    bulkForEach(
      (i) => api.setIssueState(i.repo, i.number, 'closed'),
      (n) => `Closed ${n} issue${n === 1 ? '' : 's'}`,
    );

  const bulkAiTriage = (): void => {
    const targets = visibleIssues.filter((i) => selection.has(issueKey(i)));
    void runBulk(targets, (i) => api.triageIssue(i.repo, i.number), {
      label: (i) => `#${i.number}`,
      onSettled: (total, failures) => {
        selection.clear();
        if (failures.length > 0) setBulkError(`Failed to start for ${failures.join(', ')}`);
        else show(`Triage started for ${total} issue${total === 1 ? '' : 's'}`);
      },
    });
  };
  const bulkRunPipeline = (pipelineId: string): void => {
    const name = pipelines.find((pl) => pl.id === pipelineId)?.name ?? 'Pipeline';
    const targets = visibleIssues.filter((i) => selection.has(issueKey(i)));
    void runBulk(targets, (i) => api.runPipelineOnIssue(i.repo, i.number, pipelineId), {
      label: (i) => `#${i.number}`,
      onSettled: (total, failures) => {
        selection.clear();
        if (failures.length > 0) setBulkError(`Failed to start for ${failures.join(', ')}`);
        else show(`${name} started for ${total} issue${total === 1 ? '' : 's'}`);
      },
    });
  };

  const quick = async (fn: () => Promise<unknown>, done: string): Promise<void> => {
    setBulkError(null);
    try {
      await fn();
      show(done);
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
    issues: visibleIssues,
    total,
    loading,
    hasMore,
    loadMore,
    error: listError ?? refresh.error,
    unavailableRepos: refresh.unavailableRepos,
    failedRepos: refresh.failedRepos,
    canActIssues,
    canRunPipelines,
    pipelines,
    selected: selection.selected,
    toggleSelected: selection.toggle,
    selectAllLoaded: () => selection.selectAll(visibleIssues.map(issueKey)),
    clearSelected: selection.clear,
    bulkRunning,
    bulkAiTriage,
    bulkRunPipeline,
    bulkLabel,
    bulkComment,
    bulkClose,
    rowActions,
    ctx,
    setCtx,
    flash,
    bulkError,
  };
}
