import { useCallback, useEffect, useState } from 'react';
import type { PipelineRecord, PrRecord, RepoRecord } from '@companion/contract';
import { api, onServerMessage } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { useWorkspace } from '../lib/workspace.js';
import { ListFooter, PAGE_SIZE, useDebounced, useInfiniteList } from '../lib/paging.js';
import { useHashParams } from '../lib/hashParams.js';
import { Page, AssigneeNote, ChecksBadge, CommentCount, ContextMenu, Dropdown, EmptyState, FilterField, FiltersPopover, GitHubUser, LabelChips, PageHeader, PrStateIcon, Tabs, timeAgo, type ContextMenuState, type MenuAction } from '../components/ui.js';

type PrTab = 'open' | 'merged' | 'closed';

/**
 * Pull requests across every repo of the active workspace. Server-paged: only
 * the visible window is loaded; search and filters run in the database.
 */
export function PrsAreaPage(): JSX.Element {
  const { current } = useWorkspace();
  // Key data fetching on the id, not the object — a background workspaces
  // refresh must not restart the list (it read as an infinite loading loop).
  const workspaceId = current?.id;
  const { can } = useAuth();
  // Tab and filters ride the URL (#/prs?state=merged&author=__me) so back from
  // a PR detail restores the list and a filtered view is a shareable link.
  const [params, setParam] = useHashParams();
  const stateParam = params.get('state');
  const tab: PrTab = stateParam === 'merged' || stateParam === 'closed' ? stateParam : 'open';
  const setTab = (t: PrTab): void => setParam('state', t === 'open' ? null : t);
  // Remember the tab so breadcrumbs from a detail view return to it.
  useEffect(() => {
    sessionStorage.setItem('companion.tab:#/prs', tab);
  }, [tab]);

  const [search, setSearch] = useState(() => params.get('q') ?? '');
  const repoFilter = params.get('repo') ?? 'all';
  const authorFilter = params.get('author') ?? 'all';
  const assigneeFilter = params.get('assignee') ?? 'all';
  const decisionFilter = params.get('decision') ?? 'all';
  const reviewFilter = params.get('review') ?? 'all';
  const draftFilter = params.get('draft') ?? 'all';
  const setFilter = (key: string) => (value: string) => setParam(key, value === 'all' ? null : value);
  // Back/forward or a pasted link updates the search box too.
  useEffect(() => {
    const urlQ = params.get('q') ?? '';
    setSearch((s) => (s.trim() === urlQ ? s : urlQ));
  }, [params]);
  const [repos, setRepos] = useState<RepoRecord[]>([]);
  const [facets, setFacets] = useState<{ authors: string[]; assignees: string[] }>({ authors: [], assignees: [] });
  const [counts, setCounts] = useState<{ open: number; merged: number; closed: number }>({
    open: 0,
    merged: 0,
    closed: 0,
  });

  useEffect(() => {
    if (!workspaceId) return;
    api
      .workspaceRepos(workspaceId)
      .then(({ repos }) => setRepos(repos))
      .catch(() => setRepos([]));
  }, [workspaceId]);

  // Bulk actions: select open PRs, then run a pipeline or AI review on all.
  const [pipelines, setPipelines] = useState<PipelineRecord[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulkPipeline, setBulkPipeline] = useState('');
  const [bulkRunning, setBulkRunning] = useState<string | null>(null);
  const canRunPipelines = can('pipelines:run');
  const canActPrs = can('prs:act');
  // Row quick actions (hover ⋯ or right-click) + transient confirmations.
  const [ctx, setCtx] = useState<ContextMenuState | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
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

  // Selection only applies to the open tab of the current workspace.
  useEffect(() => {
    setSelected(new Set());
  }, [tab, workspaceId]);

  const toggleSelected = (key: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

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
  const [bulkError, setBulkError] = useState<string | null>(null);

  /** One-off row action with a transient confirmation. */
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

  const q = useDebounced(search.trim());
  // Mirror the debounced query into the URL without spamming history.
  useEffect(() => {
    setParam('q', q || null, { replace: true });
  }, [q, setParam]);
  const fetchPage = useCallback(
    async (offset: number) => {
      if (!workspaceId) return { items: [], total: 0 };
      const page = await api.workspacePrs(workspaceId, tab, {
        q: q || undefined,
        repo: repoFilter === 'all' ? undefined : repoFilter,
        author: authorFilter === 'all' ? undefined : authorFilter,
        assignee: assigneeFilter === 'all' ? undefined : assigneeFilter,
        decision: decisionFilter === 'all' ? undefined : decisionFilter,
        review: reviewFilter === 'all' ? undefined : reviewFilter,
        draft: draftFilter === 'all' ? undefined : draftFilter,
        limit: PAGE_SIZE,
        offset,
      });
      setCounts(page.counts);
      setFacets(page.facets);
      return { items: page.prs, total: page.total };
    },
    [workspaceId, tab, q, repoFilter, authorFilter, assigneeFilter, decisionFilter, reviewFilter, draftFilter],
  );
  const { items: prs, total, loading, hasMore, loadMore, reload, error } = useInfiniteList(fetchPage);
  const activeFilters = [repoFilter, authorFilter, assigneeFilter, decisionFilter, reviewFilter, draftFilter].filter(
    (f) => f !== 'all',
  ).length;

  useEffect(() => {
    return onServerMessage((msg) => {
      if (msg.t === 'prs.changed' || msg.t === 'pipelineRuns.changed') reload();
    });
  }, [reload]);

  if (!current) return <EmptyState title="No workspace selected" />;

  return (
    <Page>
      <PageHeader
        title="Pull Requests"
        subtitle={current.name}
        actions={
          <>
            <input
              className="input w-56"
              type="search"
              placeholder="Search PRs…  ( / )"
              data-shortcut="search"
              aria-label="Search pull requests"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <FiltersPopover
              active={activeFilters}
              onClear={() => {
                setParam('repo', null);
                setParam('author', null);
                setParam('assignee', null);
                setParam('decision', null);
                setParam('review', null);
                setParam('draft', null);
              }}
            >
              {repos.length > 1 ? (
                <FilterField label="Repository">
                  <Dropdown
                    ariaLabel="Filter by repository"
                    value={repoFilter}
                    onChange={setFilter('repo')}
                    options={[
                      { value: 'all', label: 'All repos' },
                      ...repos.map((r) => ({ value: r.fullName, label: r.fullName.split('/')[1] ?? r.fullName })),
                    ]}
                  />
                </FilterField>
              ) : null}
              <FilterField label="Author">
                <Dropdown
                  ariaLabel="Filter by author"
                  value={authorFilter}
                  onChange={setFilter('author')}
                  searchable={facets.authors.length > 8}
                  options={[
                    { value: 'all', label: 'Any author' },
                    { value: '__me', label: 'Opened by me' },
                    ...facets.authors.map((a) => ({ value: a, label: a })),
                  ]}
                />
              </FilterField>
              <FilterField label="Assignee">
                <Dropdown
                  ariaLabel="Filter by assignee"
                  value={assigneeFilter}
                  onChange={setFilter('assignee')}
                  searchable={facets.assignees.length > 8}
                  options={[
                    { value: 'all', label: 'Any assignee' },
                    { value: '__me', label: 'Assigned to me' },
                    { value: '__none', label: 'Unassigned' },
                    ...facets.assignees.map((a) => ({ value: a, label: a })),
                  ]}
                />
              </FilterField>
              <FilterField label="Review">
                <Dropdown
                  ariaLabel="Filter by review decision"
                  value={decisionFilter}
                  onChange={setFilter('decision')}
                  options={[
                    { value: 'all', label: 'Any review' },
                    { value: 'approved', label: 'Approved' },
                    { value: 'changes_requested', label: 'Changes requested' },
                    { value: 'none', label: 'No decision yet' },
                  ]}
                />
              </FilterField>
              <FilterField label="AI review">
                <Dropdown
                  ariaLabel="Filter by AI review status"
                  value={reviewFilter}
                  onChange={setFilter('review')}
                  options={[
                    { value: 'all', label: 'Any AI review' },
                    { value: 'pending', label: 'Needs review' },
                    { value: 'applied', label: 'Review posted' },
                    { value: 'dismissed', label: 'Review dismissed' },
                  ]}
                />
              </FilterField>
              <FilterField label="Drafts">
                <Dropdown
                  ariaLabel="Draft filter"
                  value={draftFilter}
                  onChange={setFilter('draft')}
                  options={[
                    { value: 'all', label: 'Included' },
                    { value: 'hide', label: 'Hidden' },
                    { value: 'only', label: 'Drafts only' },
                  ]}
                />
              </FilterField>
            </FiltersPopover>
          </>
        }
      />
      {error ? <div className="error-bar">{error}</div> : null}

      <Tabs
        value={tab}
        onChange={setTab}
        options={[
          { value: 'open', label: 'Open', count: counts.open },
          { value: 'merged', label: 'Merged', count: counts.merged },
          { value: 'closed', label: 'Closed', count: counts.closed },
        ]}
      />

      {tab === 'open' && (canActPrs || (canRunPipelines && pipelines.length > 0)) && selected.size > 0 ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-2.5 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800">
          <span className="text-[13px] font-medium tabular-nums">{selected.size} selected</span>
          <button
            className="linkish text-xs"
            onClick={() => setSelected(new Set(prs.map((pr) => `${pr.repo}#${pr.number}`)))}
          >
            select all loaded
          </button>
          <button className="linkish text-xs" onClick={() => setSelected(new Set())}>
            clear
          </button>
          <span className="flex-1" />
          {canActPrs ? (
            <button
              className="btn-ghost"
              disabled={bulkRunning !== null}
              onClick={() => void runBulkWith((pr) => api.analyzePr(pr.repo, pr.number), 'AI review')}
            >
              AI review {selected.size}
            </button>
          ) : null}
          {canRunPipelines && pipelines.length > 0 ? (
            <>
              <select
                className="input py-1.5"
                aria-label="Pipeline to run against the selected PRs"
                value={bulkPipeline}
                onChange={(e) => setBulkPipeline(e.target.value)}
              >
                <option value="">Choose pipeline…</option>
                {pipelines.map((pl) => (
                  <option key={pl.id} value={pl.id}>
                    {pl.name}
                  </option>
                ))}
              </select>
              <button
                className="btn"
                disabled={!bulkPipeline || bulkRunning !== null}
                onClick={() => void runBulkWith((pr) => api.runPipeline(pr.repo, pr.number, bulkPipeline), 'Pipeline')}
              >
                {bulkRunning ? `Starting ${bulkRunning}…` : `Run against ${selected.size} PR${selected.size === 1 ? '' : 's'}`}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {bulkError ? <div className="error-bar">{bulkError}</div> : null}
      {flash ? <div className="banner-info my-2" role="status">{flash}</div> : null}

      {prs.length === 0 && !loading ? (
        <EmptyState
          title={q || repoFilter !== 'all' ? 'No pull requests match the filters' : `No ${tab} pull requests`}
        />
      ) : (
        <div className="card mt-3 divide-y divide-zinc-200 p-0 dark:divide-zinc-800" aria-label="Pull request list">
          {prs.map((pr) => (
            <a
              key={`${pr.repo}#${pr.number}`}
              className="row-link group/row"
              href={`#/repos/${pr.repo}/prs/${pr.number}`}
              onContextMenu={(e) => {
                e.preventDefault();
                setCtx({ x: e.clientX, y: e.clientY, actions: rowActions(pr) });
              }}
            >
              {tab === 'open' && (canActPrs || (canRunPipelines && pipelines.length > 0)) ? (
                <span
                  role="checkbox"
                  aria-checked={selected.has(`${pr.repo}#${pr.number}`)}
                  aria-label={`Select #${pr.number} for a bulk pipeline run`}
                  tabIndex={0}
                  className={`flex size-4 shrink-0 cursor-pointer items-center justify-center rounded border transition-opacity ${
                    selected.has(`${pr.repo}#${pr.number}`)
                      ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
                      : 'border-zinc-300 text-transparent hover:border-zinc-500 dark:border-zinc-600 dark:hover:border-zinc-400'
                  } ${selected.size > 0 ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100'}`}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    toggleSelected(`${pr.repo}#${pr.number}`);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === ' ' || e.key === 'Enter') {
                      e.preventDefault();
                      e.stopPropagation();
                      toggleSelected(`${pr.repo}#${pr.number}`);
                    }
                  }}
                >
                  <svg viewBox="0 0 16 16" fill="none" className="size-3" aria-hidden>
                    <path d="m3.5 8.5 3 3 6-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              ) : null}
              <PrStateIcon state={pr.state} draft={pr.draft} decision={pr.reviewDecision} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="truncate font-medium">{pr.title}</span>
                  {pr.review ? (
                    <span className={`shrink-0 ${pr.review === 'applied' ? 'badge-ok' : 'badge-warn'}`}>
                      review {pr.review}
                    </span>
                  ) : null}
                  {pr.reviewRisk ? (
                    <span
                      className={`shrink-0 ${
                        pr.reviewRisk === 'low' ? 'badge-ok' : pr.reviewRisk === 'medium' ? 'badge-warn' : 'badge-danger'
                      }`}
                    >
                      risk {pr.reviewRisk}
                    </span>
                  ) : null}
                </span>
                <span className="dim mt-0.5 flex items-center gap-1.5 text-xs">
                  <span className="min-w-0 truncate">
                    {repos.length > 1 ? `${pr.repo.split('/')[1]} · ` : ''}#{pr.number} ·{' '}
                    <GitHubUser login={pr.author} />
                  </span>
                  <AssigneeNote assignees={pr.assignees} />
                  <LabelChips labels={pr.labels} />
                </span>
              </span>
              <CommentCount count={pr.comments} />
              <ChecksBadge checks={pr.checks} />
              <span className="dim w-16 shrink-0 text-right" title={new Date(pr.updatedAt).toLocaleString()}>
                {timeAgo(pr.updatedAt)}
              </span>
              <button
                className="dim -mr-1 shrink-0 cursor-pointer rounded-md p-1 opacity-0 transition-opacity group-hover/row:opacity-100 hover:bg-zinc-200 hover:text-zinc-800 focus-visible:opacity-100 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
                aria-label={`Quick actions for #${pr.number}`}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const r = e.currentTarget.getBoundingClientRect();
                  setCtx({ x: r.right - 224, y: r.bottom + 4, actions: rowActions(pr) });
                }}
              >
                <svg viewBox="0 0 16 16" className="size-4 fill-current" aria-hidden>
                  <circle cx="3" cy="8" r="1.4" />
                  <circle cx="8" cy="8" r="1.4" />
                  <circle cx="13" cy="8" r="1.4" />
                </svg>
              </button>
            </a>
          ))}
          <ListFooter
            loading={loading}
            hasMore={hasMore}
            shown={prs.length}
            total={total}
            noun="pull requests"
            onVisible={loadMore}
          />
        </div>
      )}
      <ContextMenu menu={ctx} onClose={() => setCtx(null)} />
    </Page>
  );
}
