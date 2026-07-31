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
  Page,
  PageHeader,
  RowsSkeleton,
  rowDelay,
  useSettledFlag,
  SearchInput,
  Tabs,
  timeAgo,
} from '@moxxy/companion-sdk/ui';
import { BulkBar } from '../components/BulkBar.js';
import { useWorkspaceIssues } from '../hooks/useWorkspaceIssues.js';
import { RepoUnavailableRow } from '../components/RepoUnavailableRow.js';
import { SyncFailureBanner } from '../components/SyncFailureBanner.js';
import { AssigneeNote, CommentCount, GitHubUser, LabelChips, TriageLegend, TriageStateIcon } from '../widgets.js';

/**
 * Issues across every repo of the active workspace. Server-paged: only the
 * visible window is loaded; search and filters run in the database.
 */
export function IssuesAreaPage(): JSX.Element {
  const s = useWorkspaceIssues();
  // A skeleton that appears and vanishes inside a blink reads as a glitch.
  const settling = useSettledFlag(s.loading);
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
    unavailableRepos,
    failedRepos,
    canActIssues,
    canRunPipelines,
    pipelines,
    selected,
    toggleSelected,
    selectAllLoaded,
    clearSelected,
    bulkRunning,
    bulkAiTriage,
    bulkLabel,
    bulkComment,
    bulkClose,
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
  const unavailable = unavailableRepos.filter((repo) => repoFilter === 'all' || repoFilter === repo);
  const failed = failedRepos.filter((failure) => repoFilter === 'all' || repoFilter === failure.repo);

  return (
    <Page>
      <PageHeader
        title="Issues"
        subtitle={current.name}
        actions={
          <>
            <SearchInput value={search} onChange={setSearch} placeholder="Search issues…  ( / )" ariaLabel="Search issues" />
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
      <ErrorBar error={error} />

      <Tabs
        value={tab}
        onChange={setTab}
        options={[
          { value: 'open', label: 'Open', count: counts.open },
          { value: 'closed', label: 'Closed', count: counts.closed },
        ]}
      />

      {tab === 'open' && (canActIssues || (canRunPipelines && pipelines.length > 0)) && selected.size > 0 ? (
        <BulkBar
          count={selected.size}
          noun="issue"
          busy={bulkRunning !== null}
          running={bulkRunning}
          canAct={canActIssues}
          ai={canActIssues ? { label: 'AI triage', onRun: bulkAiTriage } : null}
          pipelines={canRunPipelines ? pipelines : []}
          onRunPipeline={bulkRunPipeline}
          onLabel={bulkLabel}
          onComment={bulkComment}
          onCloseItems={bulkClose}
          onSelectAll={selectAllLoaded}
          onClear={clearSelected}
        />
      ) : null}
      <ErrorBar error={bulkError} />
      {flash ? <div className="banner-info my-2" role="status">{flash}</div> : null}
      <SyncFailureBanner failures={failed} />

      {issues.length === 0 && unavailable.length === 0 && !loading ? (
        <EmptyState
          title={search.trim() || repoFilter !== 'all' ? 'No issues match the filters' : `No ${tab} issues`}
          hint={!search.trim() && repoFilter === 'all' ? 'Connect repositories to this workspace to start syncing issues.' : undefined}
        />
      ) : (
        <>
        <ListCard className="mt-3" ariaLabel="Issue list">
          {settling && issues.length === 0 ? <RowsSkeleton rows={6} /> : null}
          {!loading ? unavailable.map((repo) => <RepoUnavailableRow key={repo} repo={repo} />) : null}
          {issues.map((issue, i) => (
            <a
              key={`${issue.repo}#${issue.number}`}
              style={rowDelay(i)}
              className="row-link group/row row-in"
              href={`#/repos/${issue.repo}/issues/${issue.number}`}
              onContextMenu={(e) => {
                e.preventDefault();
                setCtx({ x: e.clientX, y: e.clientY, actions: rowActions(issue) });
              }}
            >
              {tab === 'open' && (canActIssues || (canRunPipelines && pipelines.length > 0)) ? (
                <Checkbox
                  checked={selected.has(`${issue.repo}#${issue.number}`)}
                  onToggle={() => toggleSelected(`${issue.repo}#${issue.number}`)}
                  label={`Select #${issue.number} for a bulk pipeline run`}
                  className={selected.size > 0 ? 'opacity-100' : 'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100'}
                />
              ) : null}
              <TriageStateIcon triage={issue.triage} />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{issue.title}</span>
                <span className="dim mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  <span className="min-w-0 truncate">
                    {repos.length > 1 ? `${issue.repo.split('/')[1]} · ` : ''}#{issue.number} ·{' '}
                    <GitHubUser login={issue.author} />
                  </span>
                  {aiActivity.get(`${issue.repo}#${issue.number}`) ? (
                    <AiActivityChip activity={aiActivity.get(`${issue.repo}#${issue.number}`)!} />
                  ) : null}
                  <AssigneeNote assignees={issue.assignees} />
                  <LabelChips labels={issue.labels} />
                </span>
              </span>
              <CommentCount count={issue.comments} />
              <span className="dim w-16 shrink-0 text-right" title={new Date(issue.updatedAt).toLocaleString()}>
                {timeAgo(issue.updatedAt)}
              </span>
              <IconButton
                label={`Quick actions for #${issue.number}`}
                className="-mr-1 opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const r = e.currentTarget.getBoundingClientRect();
                  setCtx({ x: r.right - 224, y: r.bottom + 4, actions: rowActions(issue) });
                }}
              >
                <KebabIcon />
              </IconButton>
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
        </ListCard>
        <TriageLegend />
        </>
      )}
      <ContextMenu menu={ctx} onClose={() => setCtx(null)} />
    </Page>
  );
}
