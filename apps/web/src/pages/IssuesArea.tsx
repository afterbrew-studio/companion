import { useWorkspaceIssues } from '../hooks/useWorkspaceIssues.js';
import { useAiActivity } from '../hooks/useAiActivity.js';
import { ListFooter } from '../lib/paging.js';
import { Page, AiActivityChip, AssigneeNote, CommentCount, ContextMenu, Dropdown, EmptyState, FilterField, FiltersPopover, GitHubUser, LabelChips, PageHeader, Tabs, TriageLegend, TriageStateIcon, timeAgo } from '../components/ui.js';

/**
 * Issues across every repo of the active workspace. Server-paged: only the
 * visible window is loaded; search and filters run in the database.
 */
export function IssuesAreaPage(): JSX.Element {
  const s = useWorkspaceIssues();
  const aiActivity = useAiActivity();
  const {
    current,
    tab,
    setTab,
    search,
    setSearch,
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
  } = s;
  const {
    repo: repoFilter,
    author: authorFilter,
    assignee: assigneeFilter,
    label: labelFilter,
    triage: triageFilter,
  } = s.filters;

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
            <FiltersPopover active={activeFilters} onClear={clearFilters}>
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
              <FilterField label="Label">
                <Dropdown
                  ariaLabel="Filter by label"
                  value={labelFilter}
                  onChange={setFilter('label')}
                  searchable={facets.labels.length > 8}
                  options={[{ value: 'all', label: 'Any label' }, ...facets.labels.map((l) => ({ value: l, label: l }))]}
                />
              </FilterField>
              <FilterField label="Triage">
                <Dropdown
                  ariaLabel="Filter by triage status"
                  value={triageFilter}
                  onChange={setFilter('triage')}
                  options={[
                    { value: 'all', label: 'Any triage' },
                    { value: 'pending', label: 'Pending triage' },
                    { value: 'applied', label: 'Triage applied' },
                    { value: 'dismissed', label: 'Triage dismissed' },
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
          { value: 'closed', label: 'Closed', count: counts.closed },
        ]}
      />

      {tab === 'open' && (canActIssues || (canRunPipelines && pipelines.length > 0)) && selected.size > 0 ? (
        <div className="mt-2.5 flex flex-wrap items-center gap-2.5 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800">
          <span className="text-[13px] font-medium tabular-nums">{selected.size} selected</span>
          <button className="linkish text-xs" onClick={selectAllLoaded}>
            select all loaded
          </button>
          <button className="linkish text-xs" onClick={clearSelected}>
            clear
          </button>
          <span className="flex-1" />
          {canActIssues ? (
            <button className="btn-ghost" disabled={bulkRunning !== null} onClick={bulkAiTriage}>
              AI triage {selected.size}
            </button>
          ) : null}
          {canRunPipelines && pipelines.length > 0 ? (
            <>
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
              <button className="btn" disabled={!bulkPipeline || bulkRunning !== null} onClick={bulkRunPipeline}>
                {bulkRunning ? `Starting ${bulkRunning}…` : `Run against ${selected.size} issue${selected.size === 1 ? '' : 's'}`}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {bulkError ? <div className="error-bar">{bulkError}</div> : null}
      {flash ? <div className="banner-info my-2" role="status">{flash}</div> : null}

      {issues.length === 0 && !loading ? (
        <EmptyState
          title={search.trim() || repoFilter !== 'all' ? 'No issues match the filters' : `No ${tab} issues`}
          hint={!search.trim() && repoFilter === 'all' ? 'Connect repositories to this workspace to start syncing issues.' : undefined}
        />
      ) : (
        <>
        <div className="card mt-3 divide-y divide-zinc-200 p-0 dark:divide-zinc-800" aria-label="Issue list">
          {issues.map((issue) => (
            <a
              key={`${issue.repo}#${issue.number}`}
              className="row-link group/row"
              href={`#/repos/${issue.repo}/issues/${issue.number}`}
              onContextMenu={(e) => {
                e.preventDefault();
                setCtx({ x: e.clientX, y: e.clientY, actions: rowActions(issue) });
              }}
            >
              {tab === 'open' && (canActIssues || (canRunPipelines && pipelines.length > 0)) ? (
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
              <TriageStateIcon triage={issue.triage} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="truncate font-medium">{issue.title}</span>
                  {aiActivity.get(`${issue.repo}#${issue.number}`) ? (
                    <AiActivityChip activity={aiActivity.get(`${issue.repo}#${issue.number}`)!} />
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
              <button
                className="dim -mr-1 shrink-0 cursor-pointer rounded-md p-1 opacity-0 transition-opacity group-hover/row:opacity-100 hover:bg-zinc-200 hover:text-zinc-800 focus-visible:opacity-100 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
                aria-label={`Quick actions for #${issue.number}`}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const r = e.currentTarget.getBoundingClientRect();
                  setCtx({ x: r.right - 224, y: r.bottom + 4, actions: rowActions(issue) });
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
            shown={issues.length}
            total={total}
            noun="issues"
            onVisible={loadMore}
          />
        </div>
        <TriageLegend />
        </>
      )}
      <ContextMenu menu={ctx} onClose={() => setCtx(null)} />
    </Page>
  );
}
