import { useState } from 'react';
import { runIntent, useIntent } from '@moxxy/companion-core/client';
import { useAuth } from '@companion/module-core/client';
import {
  Dropdown,
  EmptyState,
  ErrorBar,
  FilterField,
  FiltersPopover,
  FormActions,
  ListCard,
  ListFooter,
  Page,
  PageHeader,
  PageLoading,
  SearchInput,
  Modal,
  Spinner,
  StatusDot,
  formatTokens,
  timeAgo,
  useHashFilters,
  useHashSearch,
} from '@moxxy/companion-ui';
import { useWorkspace } from '@companion/module-workspace/client';
import type { RunKind, RunListRecord, RunStatus } from '../../contract/index.js';
import { operateApi as api } from '../api.js';
import { useRunsPage } from '../hooks/useRuns.js';
import { useWorkspaceRepos } from '../hooks/useWorkspaceRepos.js';

export function statusBadge(status: RunStatus, live: boolean): string {
  // Idle attended chats keep a live gateway but shouldn't read as active.
  if (status === 'idle') return 'badge';
  if (live || status === 'running' || status === 'review') return 'badge-ok';
  if (status === 'failed' || status === 'interrupted') return 'badge-danger';
  return 'badge';
}

const KIND_OPTIONS: ReadonlyArray<{ value: RunKind; label: string }> = [
  { value: 'interactive', label: 'Interactive chat' },
  { value: 'assistant', label: 'AI Help' },
  { value: 'triage', label: 'Triage' },
  { value: 'fix', label: 'Fix' },
  { value: 'analysis', label: 'Analysis / review' },
  { value: 'implement', label: 'Implement' },
  { value: 'report', label: 'Report' },
];

/** Coarse status buckets — what you actually filter by when hunting a run. */
const STATUS_OPTIONS = [
  { value: 'active', label: 'Active (including review)' },
  { value: 'review', label: 'Needs review' },
  { value: 'running', label: 'Running' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed / interrupted' },
  { value: 'stopped', label: 'Stopped / abandoned' },
] as const;

export function RunsPage(): JSX.Element {
  const { can } = useAuth();
  const { filters, setFilter, clearFilters, activeFilters } = useHashFilters(['kind', 'status', 'repo'] as const);
  const { search, setSearch, q } = useHashSearch();
  const { current } = useWorkspace();
  const wsRepos = useWorkspaceRepos(current?.id);
  const selectedKind = KIND_OPTIONS.some((option) => option.value === filters.kind) ? filters.kind : undefined;
  const selectedStatus = STATUS_OPTIONS.some((option) => option.value === filters.status)
    ? filters.status
    : undefined;
  const { runs, total, loading, hasMore, loadMore, error, setError, refresh } = useRunsPage({
    workspaceId: current?.id,
    q: q || undefined,
    repo: filters.repo === 'all' ? undefined : filters.repo,
    kind: selectedKind,
    status: selectedStatus,
  });
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const canStart = can('runs:act');

  const createRun = async (): Promise<void> => {
    setCreating(true);
    setError(null);
    try {
      const { run } = await api.createRun();
      location.hash = `#/runs/${run.id}`;
    } catch (err) {
      setError(String(err));
    } finally {
      setCreating(false);
    }
  };

  useIntent('new-agent-run', () => {
    if (canStart) setShowCreate(true);
  });

  if (!current) {
    return (
      <Page>
        <PageHeader title="Agent activity" subtitle="Every conversation, review, fix, and implementation in one history" />
        <EmptyState
          title="Create a workspace first"
          hint="Agent work always belongs to a workspace, so its context and decisions stay together."
          action={
            can('workspaces:create') ? (
              <button className="btn" onClick={() => runIntent('new-workspace')}>Create workspace</button>
            ) : undefined
          }
        />
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        title="Agent activity"
        subtitle={`${current.name} · every conversation, review, fix, and implementation in one history`}
        actions={
          <div className="flex items-center gap-1.5">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Search runs…  ( / )"
              ariaLabel="Search title, repository, or run id"
            />
            <FiltersPopover active={activeFilters} onClear={clearFilters}>
              <FilterField label="Kind">
                <Dropdown
                  ariaLabel="Filter runs by kind"
                  value={selectedKind ?? 'all'}
                  onChange={setFilter('kind')}
                  options={[
                    { value: 'all', label: 'All kinds' },
                    ...KIND_OPTIONS.map((option) => ({ value: option.value, label: option.label })),
                  ]}
                />
              </FilterField>
              <FilterField label="Status">
                <Dropdown
                  ariaLabel="Filter runs by status"
                  value={selectedStatus ?? 'all'}
                  onChange={setFilter('status')}
                  options={[
                    { value: 'all', label: 'Any status' },
                    ...STATUS_OPTIONS.map((option) => ({ value: option.value, label: option.label })),
                  ]}
                />
              </FilterField>
              {wsRepos.length > 0 ? (
                <FilterField label="Repository">
                  <Dropdown
                    ariaLabel="Filter runs by repository"
                    value={filters.repo}
                    onChange={setFilter('repo')}
                    searchable
                    options={[
                      { value: 'all', label: 'All repositories' },
                      ...wsRepos.map((repo) => ({ value: repo.fullName, label: repo.fullName })),
                    ]}
                  />
                </FilterField>
              ) : null}
            </FiltersPopover>
            {canStart ? (
              <button className="btn" disabled={creating} onClick={() => setShowCreate(true)}>
                Start agent task
              </button>
            ) : null}
          </div>
        }
      />
      <ErrorBar error={error} className="mb-3" />

      {runs === null ? (
        <PageLoading label="Loading agent runs…" />
      ) : error && runs.length === 0 ? (
        <EmptyState
          title="Could not load agent runs"
          hint="Retry when the service is reachable. Existing runs were not changed."
          action={<button className="btn" onClick={refresh}>Retry</button>}
        />
      ) : runs.length === 0 && activeFilters === 0 && !search.trim() ? (
        <EmptyState
          title="No agent work yet"
          hint="Start a task here, or ask for triage, a fix, or a review from the issue or pull request where the work belongs."
          action={
            canStart ? (
              <button className="btn" disabled={creating} onClick={() => setShowCreate(true)}>
                Start the first agent task
              </button>
            ) : undefined
          }
        />
      ) : runs.length === 0 ? (
        <EmptyState title="No runs match" hint="Loosen the search or clear the filters." />
      ) : (
        <>
          <ListCard>
            {runs.map((run: RunListRecord) => (
              <a key={run.id} className="row-link" href={`#/runs/${run.id}`}>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="truncate font-medium">{run.title}</span>
                    {run.status === 'review' ? <span className="badge-warn shrink-0">needs review</span> : null}
                    {run.prUrl ? <span className="badge-ok shrink-0">PR ✓</span> : null}
                  </span>
                  <span className="dim block truncate text-xs">
                    {run.live ? 'live' : run.status} · {run.kind}
                    {run.model ? ` · ${run.model}` : ''}
                    {run.repo ? ` · ${run.repo}` : ''}
                    {run.inputTokens + run.outputTokens > 0
                      ? ` · ${formatTokens(run.inputTokens)} in · ${formatTokens(run.outputTokens)} out`
                      : ''}
                  </span>
                </span>
                <span className="dim shrink-0" title={new Date(run.createdAt).toLocaleString()}>
                  {timeAgo(run.createdAt)}
                </span>
                {run.live ? (
                  <Spinner />
                ) : (
                  <StatusDot
                    tone={
                      run.status === 'failed' || run.status === 'interrupted'
                        ? 'red'
                        : run.status === 'review'
                          ? 'amber'
                          : run.status === 'completed'
                            ? 'green'
                            : 'zinc'
                    }
                    title={run.status}
                  />
                )}
              </a>
            ))}
          </ListCard>
          <ListFooter
            loading={loading}
            hasMore={hasMore}
            shown={runs.length}
            total={total}
            noun="runs"
            onVisible={loadMore}
          />
        </>
      )}
      {showCreate ? (
        <Modal title="Start agent task" onClose={() => setShowCreate(false)}>
          <p className="dim text-sm leading-6">
            Start a blank conversation, then choose the repository and describe the outcome on the next screen.
            Any proposed code change still waits for your review.
          </p>
          <FormActions>
            <button className="btn-ghost" type="button" onClick={() => setShowCreate(false)}>Cancel</button>
            <button className="btn" type="button" disabled={creating} onClick={() => void createRun()}>
              {creating ? 'Starting…' : 'Continue'}
            </button>
          </FormActions>
        </Modal>
      ) : null}
    </Page>
  );
}
