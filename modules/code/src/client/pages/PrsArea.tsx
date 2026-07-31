import { useAiActivity } from '@companion/module-operate/client';
import { useAuth } from '@companion/module-core/client';
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
  rowDelay,
  useSettledFlag,
  SearchInput,
  Tabs,
  timeAgo,
} from '@moxxy/companion-sdk/ui';
import { useWorkspacePrs } from '../hooks/useWorkspacePrs.js';
import { Slot } from '@moxxy/companion-sdk/client';
import { BulkBar } from '../components/BulkBar.js';
import { PrSelectionProvider } from '../pr-selection.js';
import { RepoUnavailableRow } from '../components/RepoUnavailableRow.js';
import { SyncFailureBanner } from '../components/SyncFailureBanner.js';
import { AssigneeNote, ChecksIcon, CommentCount, GitHubUser, LabelChips, PrStateIcon } from '../widgets.js';

/**
 * Pull requests across every repo of the active workspace. Server-paged: only
 * the visible window is loaded; search and filters run in the database.
 */
export function PrsAreaPage(): JSX.Element {
  const { can } = useAuth();
  const s = useWorkspacePrs();
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
    prs,
    total,
    loading,
    hasMore,
    loadMore,
    error,
    unavailableRepos,
    failedRepos,
    canActPrs,
    canRunPipelines,
    pipelines,
    selected,
    toggleSelected,
    selectAllLoaded,
    clearSelected,
    bulkRunning,
    bulkAiReview,
    bulkLabel,
    bulkComment,
    bulkClose,
    bulkRerunChecks,
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
  const unavailable = unavailableRepos.filter((repo) => repoFilter === 'all' || repoFilter === repo);
  const failed = failedRepos.filter((failure) => repoFilter === 'all' || repoFilter === failure.repo);

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
        <BulkBar
          count={selected.size}
          noun="PR"
          busy={bulkRunning !== null}
          running={bulkRunning}
          canAct={canActPrs}
          ai={canActPrs ? { label: 'AI review', onRun: bulkAiReview } : null}
          pipelines={canRunPipelines ? pipelines : []}
          onRunPipeline={bulkRunPipeline}
          onLabel={bulkLabel}
          onComment={bulkComment}
          onCloseItems={bulkClose}
          onRerunChecks={canActPrs ? bulkRerunChecks : undefined}
          onSelectAll={selectAllLoaded}
          onClear={clearSelected}
        >
          {/* Other modules' bulk verbs (slop screening, for one) land here so
              this module never imports theirs. */}
          <PrSelectionProvider
            value={{
              selected: prs.filter((pr) => selected.has(`${pr.repo}#${pr.number}`)),
              clear: clearSelected,
              busy: bulkRunning !== null,
            }}
          >
            <Slot name="prs.bulkActions" can={can} />
          </PrSelectionProvider>
        </BulkBar>
      ) : null}
      <ErrorBar error={bulkError} />
      {flash ? <div className="banner-info my-2" role="status">{flash}</div> : null}
      <SyncFailureBanner failures={failed} />

      {prs.length === 0 && unavailable.length === 0 && !loading ? (
        <EmptyState
          title={search.trim() || repoFilter !== 'all' ? 'No pull requests match the filters' : `No ${tab} pull requests`}
        />
      ) : (
        <ListCard className="mt-3" ariaLabel="Pull request list">
          {settling && prs.length === 0 ? <RowsSkeleton rows={6} /> : null}
          {!loading ? unavailable.map((repo) => <RepoUnavailableRow key={repo} repo={repo} />) : null}
          {prs.map((pr, i) => (
            <a
              key={`${pr.repo}#${pr.number}`}
              style={rowDelay(i)}
              className="row-link group/row row-in"
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
              <ChecksIcon checks={pr.checks} />
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
