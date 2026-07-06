import { useCallback, useEffect, useState } from 'react';
import type { PipelineRecord, RepoRecord } from '@companion/contract';
import { api, onServerMessage } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { useWorkspace } from '../lib/workspace.js';
import { ListFooter, PAGE_SIZE, useDebounced, useInfiniteList } from '../lib/paging.js';
import { Page, AssigneeNote, CommentCount, Dropdown, EmptyState, FilterField, FiltersPopover, GitHubUser, LabelChips, PageHeader, Tabs, timeAgo } from '../components/ui.js';

type IssueTab = 'open' | 'closed';

function tabFromHash(): IssueTab {
  return new URLSearchParams(location.hash.split('?')[1] ?? '').get('state') === 'closed' ? 'closed' : 'open';
}

/**
 * Issues across every repo of the active workspace. Server-paged: only the
 * visible window is loaded; search and filters run in the database.
 */
export function IssuesAreaPage(): JSX.Element {
  const { current } = useWorkspace();
  const { can } = useAuth();
  // Tab state rides the URL (#/issues?state=closed) so back navigation works.
  const [tab, setTabState] = useState<IssueTab>(tabFromHash);
  const setTab = (t: IssueTab): void => {
    const base = location.hash.split('?')[0] || '#/issues';
    location.hash = t === 'open' ? base : `${base}?state=${t}`;
  };
  useEffect(() => {
    const onHash = (): void => setTabState(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  // Remember the tab so breadcrumbs from a detail view return to it.
  useEffect(() => {
    sessionStorage.setItem('companion.tab:#/issues', tab);
  }, [tab]);

  const [search, setSearch] = useState('');
  const [repoFilter, setRepoFilter] = useState<string>('all');
  const [authorFilter, setAuthorFilter] = useState<string>('all');
  const [assigneeFilter, setAssigneeFilter] = useState<string>('all');
  const [labelFilter, setLabelFilter] = useState<string>('all');
  const [repos, setRepos] = useState<RepoRecord[]>([]);
  const [facets, setFacets] = useState<{ authors: string[]; assignees: string[]; labels: string[] }>({
    authors: [],
    assignees: [],
    labels: [],
  });
  const [counts, setCounts] = useState<{ open: number; closed: number }>({ open: 0, closed: 0 });

  useEffect(() => {
    if (!current) return;
    api
      .workspaceRepos(current.id)
      .then(({ repos }) => setRepos(repos))
      .catch(() => setRepos([]));
  }, [current]);

  // Bulk pipeline runs: select open issues, pick an issue pipeline, run on all.
  const [pipelines, setPipelines] = useState<PipelineRecord[]>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulkPipeline, setBulkPipeline] = useState('');
  const [bulkRunning, setBulkRunning] = useState<string | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const canRunPipelines = can('pipelines:run');

  useEffect(() => {
    if (!current || !can('pipelines:read')) return;
    api
      .workspacePipelines(current.id)
      .then((r) => setPipelines(r.pipelines.filter((pl) => pl.type === 'issue')))
      .catch(() => setPipelines([]));
  }, [current, can]);

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
    const targets = issues.filter((i) => selected.has(`${i.repo}#${i.number}`));
    const failures: string[] = [];
    for (let i = 0; i < targets.length; i++) {
      const issue = targets[i]!;
      setBulkRunning(`${i + 1}/${targets.length}`);
      try {
        await api.runPipelineOnIssue(issue.repo, issue.number, bulkPipeline);
      } catch {
        failures.push(`#${issue.number}`);
      }
    }
    setBulkRunning(null);
    setSelected(new Set());
    if (failures.length > 0) setBulkError(`Failed to start for ${failures.join(', ')}`);
  };

  const q = useDebounced(search.trim());
  const fetchPage = useCallback(
    async (offset: number) => {
      if (!current) return { items: [], total: 0 };
      const page = await api.workspaceIssues(current.id, tab, {
        q: q || undefined,
        repo: repoFilter === 'all' ? undefined : repoFilter,
        author: authorFilter === 'all' ? undefined : authorFilter,
        assignee: assigneeFilter === 'all' ? undefined : assigneeFilter,
        label: labelFilter === 'all' ? undefined : labelFilter,
        limit: PAGE_SIZE,
        offset,
      });
      setCounts(page.counts);
      setFacets(page.facets);
      return { items: page.issues, total: page.total };
    },
    [current, tab, q, repoFilter, authorFilter, assigneeFilter, labelFilter],
  );
  const { items: issues, total, loading, hasMore, loadMore, reload, error } = useInfiniteList(fetchPage);
  const activeFilters = [repoFilter, authorFilter, assigneeFilter, labelFilter].filter((f) => f !== 'all').length;

  useEffect(() => {
    return onServerMessage((msg) => {
      if (msg.t === 'issues.changed' || msg.t === 'triage.changed') reload();
    });
  }, [reload]);

  if (!current) return <EmptyState title="No workspace selected" />;

  return (
    <Page>
      <PageHeader
        title="Issues"
        subtitle={current.name}
        actions={
          <>
            <input
              className="input w-56"
              type="search"
              placeholder="Search issues…  ( / )"
              data-shortcut="search"
              aria-label="Search issues"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <FiltersPopover
              active={activeFilters}
              onClear={() => {
                setRepoFilter('all');
                setAuthorFilter('all');
                setAssigneeFilter('all');
                setLabelFilter('all');
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
              <FilterField label="Label">
                <Dropdown
                  ariaLabel="Filter by label"
                  value={labelFilter}
                  onChange={setLabelFilter}
                  searchable={facets.labels.length > 8}
                  options={[{ value: 'all', label: 'Any label' }, ...facets.labels.map((l) => ({ value: l, label: l }))]}
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
          { value: 'closed', label: 'Closed', count: counts.closed },
        ]}
      />

      {tab === 'open' && canRunPipelines && pipelines.length > 0 && selected.size > 0 ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-2.5 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800">
          <span className="text-[13px] font-medium tabular-nums">{selected.size} selected</span>
          <button
            className="linkish text-xs"
            onClick={() => setSelected(new Set(issues.map((i) => `${i.repo}#${i.number}`)))}
          >
            select all loaded
          </button>
          <button className="linkish text-xs" onClick={() => setSelected(new Set())}>
            clear
          </button>
          <span className="flex-1" />
          <select
            className="input py-1.5"
            aria-label="Issue pipeline to run against the selected issues"
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
            {bulkRunning ? `Starting ${bulkRunning}…` : `Run against ${selected.size} issue${selected.size === 1 ? '' : 's'}`}
          </button>
        </div>
      ) : null}
      {bulkError ? <div className="error-bar">{bulkError}</div> : null}

      {issues.length === 0 && !loading ? (
        <EmptyState
          title={q || repoFilter !== 'all' ? 'No issues match the filters' : `No ${tab} issues`}
          hint={!q && repoFilter === 'all' ? 'Connect repositories to this workspace to start syncing issues.' : undefined}
        />
      ) : (
        <div className="card mt-3 divide-y divide-zinc-200 p-0 dark:divide-zinc-800" aria-label="Issue list">
          {issues.map((issue) => (
            <a
              key={`${issue.repo}#${issue.number}`}
              className="row-link group/row"
              href={`#/repos/${issue.repo}/issues/${issue.number}`}
            >
              {tab === 'open' && canRunPipelines && pipelines.length > 0 ? (
                <span
                  role="checkbox"
                  aria-checked={selected.has(`${issue.repo}#${issue.number}`)}
                  aria-label={`Select #${issue.number} for a bulk pipeline run`}
                  tabIndex={0}
                  className={`flex size-4 shrink-0 cursor-pointer items-center justify-center rounded border transition-opacity ${
                    selected.has(`${issue.repo}#${issue.number}`)
                      ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
                      : 'border-zinc-300 text-transparent hover:border-zinc-500 dark:border-zinc-600 dark:hover:border-zinc-400'
                  } ${selected.size > 0 ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100'}`}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    toggleSelected(`${issue.repo}#${issue.number}`);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === ' ' || e.key === 'Enter') {
                      e.preventDefault();
                      e.stopPropagation();
                      toggleSelected(`${issue.repo}#${issue.number}`);
                    }
                  }}
                >
                  <svg viewBox="0 0 16 16" fill="none" className="size-3" aria-hidden>
                    <path d="m3.5 8.5 3 3 6-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              ) : null}
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="truncate font-medium">{issue.title}</span>
                  {issue.triage ? (
                    <span className={`shrink-0 ${issue.triage === 'applied' ? 'badge-ok' : 'badge-warn'}`}>
                      triage {issue.triage}
                    </span>
                  ) : null}
                </span>
                <span className="dim mt-0.5 flex items-center gap-1.5 text-xs">
                  <span className="min-w-0 truncate">
                    {repos.length > 1 ? `${issue.repo.split('/')[1]} · ` : ''}#{issue.number} ·{' '}
                    <GitHubUser login={issue.author} />
                  </span>
                  <AssigneeNote assignees={issue.assignees} />
                  <LabelChips labels={issue.labels} />
                </span>
              </span>
              <CommentCount count={issue.comments} />
              <span className="dim w-16 shrink-0 text-right" title={new Date(issue.updatedAt).toLocaleString()}>
                {timeAgo(issue.updatedAt)}
              </span>
            </a>
          ))}
          <ListFooter
            loading={loading}
            hasMore={hasMore}
            shown={issues.length}
            total={total}
            noun="issues"
            onVisible={loadMore}
          />
        </div>
      )}
    </Page>
  );
}
