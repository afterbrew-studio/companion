import { useAiActivity } from '@companion/module-operate/client';
import {
  AiActivityChip,
  Checkbox,
  ContextMenu,
  Dropdown,
  EmptyState,
  ErrorBar,
  FilterField,
  FiltersPopover,
  IconButton,
  KebabIcon,
  ListCard,
  ListFooter,
  MetaSignal,
  Page,
  PageHeader,
  RowsSkeleton,
  SearchInput,
  Tabs,
  timeAgo,
} from '@companion/ui';
import { useWorkspacePrs } from '../hooks/useWorkspacePrs.js';
import { AssigneeNote, ChecksBadge, CommentCount, GitHubUser, LabelChips, PrStateIcon } from '../widgets.js';

/**
 * Pull requests across every repo of the active workspace. Server-paged: only
 * the visible window is loaded; search and filters run in the database.
 */
export function PrsAreaPage(): JSX.Element {
  const s = useWorkspacePrs();
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
  } = s;
  const {
    repo: repoFilter,
    author: authorFilter,
    assignee: assigneeFilter,
    decision: decisionFilter,
    review: reviewFilter,
    draft: draftFilter,
  } = s.filters;

  if (!current) return <EmptyState title="No workspace selected" />;

  return (
    <Page>
      <PageHeader
        title="Pull Requests"
        subtitle={current.name}
        actions={
          <>
            <SearchInput value={search} onChange={setSearch} placeholder="Search PRs…  ( / )" ariaLabel="Search pull requests" />
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
      <ErrorBar error={error} />

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
          <button className="linkish text-xs" onClick={selectAllLoaded}>
            select all loaded
          </button>
          <button className="linkish text-xs" onClick={clearSelected}>
            clear
          </button>
          <span className="flex-1" />
          {canActPrs ? (
            <button className="btn-ghost" disabled={bulkRunning !== null} onClick={bulkAiReview}>
              AI review {selected.size}
            </button>
          ) : null}
          {canRunPipelines && pipelines.length > 0 ? (
            <>
              <select
                className="input input-sm"
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
              <button className="btn" disabled={!bulkPipeline || bulkRunning !== null} onClick={bulkRunPipeline}>
                {bulkRunning ? `Starting ${bulkRunning}…` : `Run against ${selected.size} PR${selected.size === 1 ? '' : 's'}`}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      <ErrorBar error={bulkError} />
      {flash ? <div className="banner-info my-2" role="status">{flash}</div> : null}

      {prs.length === 0 && !loading ? (
        <EmptyState
          title={search.trim() || repoFilter !== 'all' ? 'No pull requests match the filters' : `No ${tab} pull requests`}
        />
      ) : (
        <ListCard className="mt-3" ariaLabel="Pull request list">
          {loading && prs.length === 0 ? <RowsSkeleton rows={6} /> : null}
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
                <Checkbox
                  checked={selected.has(`${pr.repo}#${pr.number}`)}
                  onToggle={() => toggleSelected(`${pr.repo}#${pr.number}`)}
                  label={`Select #${pr.number} for a bulk pipeline run`}
                  className={selected.size > 0 ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100'}
                />
              ) : null}
              <PrStateIcon state={pr.state} draft={pr.draft} decision={pr.reviewDecision} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{pr.title}</span>
                <span className="dim mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  <span className="min-w-0 truncate">
                    {repos.length > 1 ? `${pr.repo.split('/')[1]} · ` : ''}#{pr.number} ·{' '}
                    <GitHubUser login={pr.author} />
                  </span>
                  {aiActivity.get(`${pr.repo}#${pr.number}`) ? (
                    <AiActivityChip activity={aiActivity.get(`${pr.repo}#${pr.number}`)!} />
                  ) : null}
                  {pr.reviewRisk ? (
                    <MetaSignal
                      tone={pr.reviewRisk === 'low' ? 'green' : pr.reviewRisk === 'medium' ? 'amber' : 'red'}
                      label={`${pr.reviewRisk} risk`}
                    />
                  ) : null}
                  {pr.review ? (
                    <MetaSignal
                      tone={pr.review === 'applied' ? 'green' : 'zinc'}
                      label={`review ${pr.review}`}
                    />
                  ) : null}
                  <AssigneeNote assignees={pr.assignees} />
                  <LabelChips labels={pr.labels} />
                </span>
              </span>
              <CommentCount count={pr.comments} />
              <ChecksBadge checks={pr.checks} />
              <span className="dim w-16 shrink-0 text-right" title={new Date(pr.updatedAt).toLocaleString()}>
                {timeAgo(pr.updatedAt)}
              </span>
              <IconButton
                label={`Quick actions for #${pr.number}`}
                className="-mr-1 opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const r = e.currentTarget.getBoundingClientRect();
                  setCtx({ x: r.right - 224, y: r.bottom + 4, actions: rowActions(pr) });
                }}
              >
                <KebabIcon />
              </IconButton>
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
        </ListCard>
      )}
      <ContextMenu menu={ctx} onClose={() => setCtx(null)} />
    </Page>
  );
}
