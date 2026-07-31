import { useMemo, useState } from 'react';
import {
  EmptyState,
  ErrorBar,
  FilterField,
  FiltersPopover,
  Page,
  PageHeader,
  Dropdown,
  timeAgo,
} from '@moxxy/companion-ui';
import type { QueuedRunEntry, RunKind } from '../../contract/index.js';
import { operateApi as api } from '../api.js';
import { useRunQueue } from '../hooks/useRunQueue.js';

const KIND_LABEL: Record<RunKind, string> = {
  interactive: 'Chat',
  assistant: 'AI Help',
  triage: 'Triage',
  fix: 'Fix',
  analysis: 'Review',
  implement: 'Implement',
  report: 'Report',
  command: 'Command',
};

/** Where a queued item came from. Derived, not stored: the queue is one line. */
function originOf(e: QueuedRunEntry): 'issue' | 'pr' | 'repo' | 'other' {
  if (e.issueNumber !== null) return e.kind === 'triage' ? 'issue' : 'pr';
  return e.repo ? 'repo' : 'other';
}

const ORIGIN_LABEL: Record<ReturnType<typeof originOf>, string> = {
  issue: 'Issue',
  pr: 'Pull request',
  repo: 'Repository',
  other: 'Manual',
};

/**
 * The one waiting line for machine work.
 *
 * Deliberately not split per domain. There is a single scarce resource here,
 * runner slots, and three queues over one pool could not answer the only
 * question that matters — when does mine start — because the answer depends on
 * all of them. Origin is a filter instead.
 *
 * Bulk actions that are pure GitHub calls never appear here: they are HTTP
 * requests, not machine work, and making them wait behind an agent run would be
 * a delay with nothing on the other side of it.
 */
export function QueuePage(): JSX.Element {
  const queue = useRunQueue();
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<string>('all');
  const [origin, setOrigin] = useState<string>('all');
  const [repo, setRepo] = useState<string>('all');

  const repos = useMemo(
    () => [...new Set(queue.entries.map((e) => e.repo).filter((r): r is string => r !== null))].sort(),
    [queue.entries],
  );
  const shown = queue.entries.filter(
    (e) =>
      (kind === 'all' || e.kind === kind) &&
      (origin === 'all' || originOf(e) === origin) &&
      (repo === 'all' || e.repo === repo),
  );
  const activeFilters = [kind, origin, repo].filter((v) => v !== 'all').length;
  const clearFilters = (): void => {
    setKind('all');
    setOrigin('all');
    setRepo('all');
  };

  const act = (fn: () => Promise<unknown>): void => {
    void fn().catch((e) => setError(String(e)));
  };

  const full = queue.active >= queue.capacity;

  return (
    <Page>
      <PageHeader
        title="Queue"
        subtitle={`${queue.active} of ${queue.capacity} runner slot${queue.capacity === 1 ? '' : 's'} busy${
          queue.entries.length > 0 ? `, ${queue.entries.length} waiting` : ''
        }`}
        actions={
          <FiltersPopover active={activeFilters} onClear={clearFilters}>
            <FilterField label="Kind">
              <Dropdown
                ariaLabel="Filter by kind"
                value={kind}
                onChange={setKind}
                options={[
                  { value: 'all', label: 'All kinds' },
                  ...[...new Set(queue.entries.map((e) => e.kind))].map((k) => ({
                    value: k,
                    label: KIND_LABEL[k],
                  })),
                ]}
              />
            </FilterField>
            <FilterField label="Origin">
              <Dropdown
                ariaLabel="Filter by origin"
                value={origin}
                onChange={setOrigin}
                options={[
                  { value: 'all', label: 'Anywhere' },
                  ...Object.entries(ORIGIN_LABEL).map(([value, label]) => ({ value, label })),
                ]}
              />
            </FilterField>
            <FilterField label="Repository">
              <Dropdown
                ariaLabel="Filter by repository"
                value={repo}
                onChange={setRepo}
                options={[{ value: 'all', label: 'All repositories' }, ...repos.map((r) => ({ value: r, label: r }))]}
              />
            </FilterField>
          </FiltersPopover>
        }
      />
      <ErrorBar error={error} />

      {full && queue.entries.length > 0 ? (
        <div className="card border-amber-500/40 bg-amber-500/10 text-xs">
          Every runner slot is busy. Waiting work starts as slots free up, in the order below. Nothing is
          being dropped.
        </div>
      ) : null}

      {queue.entries.length === 0 ? (
        <EmptyState
          title="Nothing waiting"
          hint="Agent runs and pipeline commands queue here when every runner slot is busy."
        />
      ) : shown.length === 0 ? (
        <EmptyState title="No queued work matches these filters" />
      ) : (
        <ol className="flex flex-col gap-2">
          {shown.map((e, i) => (
            <li key={e.id} className="card flex flex-wrap items-center gap-2" aria-label={e.title}>
              <span className="dim w-6 shrink-0 text-xs tabular-nums">{e.position}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm">{e.title}</div>
                <p className="dim mt-0.5 truncate text-xs">
                  {KIND_LABEL[e.kind]} · {ORIGIN_LABEL[originOf(e)]}
                  {e.repo ? ` · ${e.repo}` : ''}
                  {e.userId ? ` · ${e.userId}` : ''} · waiting {timeAgo(e.enqueuedAt)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  className="btn-ghost"
                  aria-label={`Move ${e.title} up`}
                  disabled={i === 0}
                  onClick={() => act(() => api.moveQueued(e.id, 'up'))}
                >
                  ↑
                </button>
                <button
                  className="btn-ghost"
                  aria-label={`Move ${e.title} down`}
                  disabled={i === shown.length - 1}
                  onClick={() => act(() => api.moveQueued(e.id, 'down'))}
                >
                  ↓
                </button>
                <button
                  className="btn-danger-ghost"
                  aria-label={`Cancel ${e.title}`}
                  onClick={() => act(() => api.cancelQueued(e.id))}
                >
                  Cancel
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Page>
  );
}
