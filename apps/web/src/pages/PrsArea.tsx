import { useCallback, useEffect, useState } from 'react';
import type { PipelineRecord, RepoRecord } from '@companion/contract';
import { api, onServerMessage } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { useWorkspace } from '../lib/workspace.js';
import { ListFooter, PAGE_SIZE, useDebounced, useInfiniteList } from '../lib/paging.js';
import { Page, AssigneeNote, ChecksBadge, CommentCount, Dropdown, EmptyState, FilterField, FiltersPopover, GitHubUser, LabelChips, PageHeader, PrStateIcon, Tabs, timeAgo } from '../components/ui.js';

type PrTab = 'open' | 'merged' | 'closed';

function tabFromHash(): PrTab {
  const state = new URLSearchParams(location.hash.split('?')[1] ?? '').get('state');
  return state === 'merged' || state === 'closed' ? state : 'open';
}

/**
 * Pull requests across every repo of the active workspace. Server-paged: only
 * the visible window is loaded; search and filters run in the database.
 */
export function PrsAreaPage(): JSX.Element {
  const { current } = useWorkspace();
  const { can } = useAuth();
  // The tab lives in the URL (#/prs?state=merged) so back from a PR detail
  // restores the list the user left.
  const [tab, setTabState] = useState<PrTab>(tabFromHash);
  const setTab = (t: PrTab): void => {
    const base = location.hash.split('?')[0] || '#/prs';
    location.hash = t === 'open' ? base : `${base}?state=${t}`;
  };
  useEffect(() => {
    const onHash = (): void => setTabState(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  // Remember the tab so breadcrumbs from a detail view return to it.
  useEffect(() => {
    sessionStorage.setItem('companion.tab:#/prs', tab);
  }, [tab]);

  const [search, setSearch] = useState('');
  const [repoFilter, setRepoFilter] = useState<string>('all');
  const [authorFilter, setAuthorFilter] = useState<string>('all');
  const [assigneeFilter, setAssigneeFilter] = useState<string>('all');
  const [decisionFilter, setDecisionFilter] = useState<string>('all');
  const [draftFilter, setDraftFilter] = useState<string>('all');
  const [repos, setRepos] = useState<RepoRecord[]>([]);
  const [facets, setFacets] = useState<{ authors: string[]; assignees: string[] }>({ authors: [], assignees: [] });
  const [counts, setCounts] = useState<{ open: number; merged: number; closed: number }>({
    open: 0,
    merged: 0,
    closed: 0,
  });

  useEffect(() => {
    if (!current) return;
    api
      .workspaceRepos(current.id)
      .then(({ repos }) => setRepos(repos))
      .catch(() => setRepos([]));
  }, [current]);

  // Bulk pipeline runs: select open PRs, pick a pipeline, run against all.
  const [pipelines, setPipelines] = useState<PipelineRecord[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulkPipeline, setBulkPipeline] = useState('');
  const [bulkRunning, setBulkRunning] = useState<string | null>(null);
  const canRunPipelines = can('pipelines:run');

  useEffect(() => {
    if (!current || !can('pipelines:read')) return;
    api
      .workspacePipelines(current.id)
      .then((r) => setPipelines(r.pipelines))
      .catch(() => setPipelines([]));
  }, [current, can]);

  // Selection only applies to the open tab of the current workspace.
  useEffect(() => {
    setSelected(new Set());
  }, [tab, current]);

  const toggleSelected = (key: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const runBulk = async (): Promise<void> => {
    if (!bulkPipeline || selected.size === 0) return;
    const targets = prs.filter((pr) => selected.has(`${pr.repo}#${pr.number}`));
    const failures: string[] = [];
    for (let i = 0; i < targets.length; i++) {
      const pr = targets[i]!;
      setBulkRunning(`${i + 1}/${targets.length}`);
      try {
        await api.runPipeline(pr.repo, pr.number, bulkPipeline);
      } catch {
        failures.push(`#${pr.number}`);
      }
    }
    setBulkRunning(null);
    setSelected(new Set());
    if (failures.length > 0) setBulkError(`Failed to start for ${failures.join(', ')}`);
  };
  const [bulkError, setBulkError] = useState<string | null>(null);

  const q = useDebounced(search.trim());
  const fetchPage = useCallback(
    async (offset: number) => {
      if (!current) return { items: [], total: 0 };
      const page = await api.workspacePrs(current.id, tab, {
        q: q || undefined,
        repo: repoFilter === 'all' ? undefined : repoFilter,
        author: authorFilter === 'all' ? undefined : authorFilter,
        assignee: assigneeFilter === 'all' ? undefined : assigneeFilter,
        decision: decisionFilter === 'all' ? undefined : decisionFilter,
        draft: draftFilter === 'all' ? undefined : draftFilter,
        limit: PAGE_SIZE,
        offset,
      });
      setCounts(page.counts);
      setFacets(page.facets);
      return { items: page.prs, total: page.total };
    },
    [current, tab, q, repoFilter, authorFilter, assigneeFilter, decisionFilter, draftFilter],
  );
  const { items: prs, total, loading, hasMore, loadMore, reload, error } = useInfiniteList(fetchPage);
  const activeFilters = [repoFilter, authorFilter, assigneeFilter, decisionFilter, draftFilter].filter(
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
                setRepoFilter('all');
                setAuthorFilter('all');
                setAssigneeFilter('all');
                setDecisionFilter('all');
                setDraftFilter('all');
              }}
            >
              {repos.length > 1 ? (
                <FilterField label="Repository">
                  <Dropdown
                    ariaLabel="Filter by repository"
                    value={repoFilter}
                    onChange={setRepoFilter}
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
                  onChange={setAuthorFilter}
                  searchable={facets.authors.length > 8}
                  options={[{ value: 'all', label: 'Any author' }, ...facets.authors.map((a) => ({ value: a, label: a }))]}
                />
              </FilterField>
              <FilterField label="Assignee">
                <Dropdown
                  ariaLabel="Filter by assignee"
                  value={assigneeFilter}
                  onChange={setAssigneeFilter}
                  searchable={facets.assignees.length > 8}
                  options={[
                    { value: 'all', label: 'Any assignee' },
                    { value: '__none', label: 'Unassigned' },
                    ...facets.assignees.map((a) => ({ value: a, label: a })),
                  ]}
                />
              </FilterField>
              <FilterField label="Review">
                <Dropdown
                  ariaLabel="Filter by review decision"
                  value={decisionFilter}
                  onChange={setDecisionFilter}
                  options={[
                    { value: 'all', label: 'Any review' },
                    { value: 'approved', label: 'Approved' },
                    { value: 'changes_requested', label: 'Changes requested' },
                    { value: 'none', label: 'No decision yet' },
                  ]}
                />
              </FilterField>
              <FilterField label="Drafts">
                <Dropdown
                  ariaLabel="Draft filter"
                  value={draftFilter}
                  onChange={setDraftFilter}
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

      {tab === 'open' && canRunPipelines && pipelines.length > 0 && selected.size > 0 ? (
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
          <button className="btn" disabled={!bulkPipeline || bulkRunning !== null} onClick={() => void runBulk()}>
            {bulkRunning ? `Starting ${bulkRunning}…` : `Run against ${selected.size} PR${selected.size === 1 ? '' : 's'}`}
          </button>
        </div>
      ) : null}
      {bulkError ? <div className="error-bar">{bulkError}</div> : null}

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
            >
              {tab === 'open' && canRunPipelines && pipelines.length > 0 ? (
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
    </Page>
  );
}
