import { useState } from 'react';
import { ErrorBar, RowsSkeleton } from '@moxxy/companion-sdk/ui';
import type { NotificationRecord } from '@companion/module-workspace/contract';
import { NotificationRow } from '@companion/module-workspace/client';

type ActivityFilter = 'all' | 'attention' | 'unread';

interface ActivityPageProps {
  readonly items: readonly NotificationRecord[];
  readonly unread: number;
  readonly loading: boolean;
  readonly error: string | null;
  readonly hasMore: boolean;
  readonly onOpen: (notification: NotificationRecord) => void;
  readonly onMarkAllRead: () => void;
  readonly onLoadMore: () => void;
}

/** Desk's event-driven inbox. Persistence, RBAC and read receipts stay owned
 * by module-workspace, so this view agrees with full Companion. */
export function ActivityPage({
  items,
  unread,
  loading,
  error,
  hasMore,
  onOpen,
  onMarkAllRead,
  onLoadMore,
}: ActivityPageProps): React.JSX.Element {
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const shown = filter === 'unread'
    ? items.filter((item) => item.readAt === null)
    : filter === 'attention'
      ? items.filter((item) => item.kind === 'action_required' || item.kind === 'error')
      : items;
  const attention = items.filter((item) =>
    item.readAt === null && (item.kind === 'action_required' || item.kind === 'error'),
  ).length;

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-[#fcfcfb] dark:bg-zinc-950" aria-label="Desk activity">
      <div className="mx-auto w-full max-w-5xl px-6 pt-5 pb-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Activity</h1>
            <p className="dim mt-1 text-xs">GitHub, mission and reviewed-action events that matter.</p>
          </div>
          <button type="button" className="btn-ghost h-8 text-xs" disabled={unread === 0} onClick={onMarkAllRead}>
            Mark all read
          </button>
        </div>

        <div className="mt-5 flex h-8 w-fit overflow-hidden rounded-md border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
          <FilterButton active={filter === 'all'} onClick={() => setFilter('all')}>All</FilterButton>
          <FilterButton active={filter === 'attention'} onClick={() => setFilter('attention')} count={attention}>Needs you</FilterButton>
          <FilterButton active={filter === 'unread'} onClick={() => setFilter('unread')} count={unread}>Unread</FilterButton>
        </div>

        <ErrorBar error={error} className="mt-4" />

        {loading && items.length === 0 ? (
          <section className="mt-4 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
            <RowsSkeleton rows={6} />
          </section>
        ) : shown.length === 0 ? (
            <div className="px-6 py-20 text-center">
              <p className="text-sm font-medium">{filter === 'all' ? 'No activity yet' : 'Nothing in this view'}</p>
              <p className="dim mx-auto mt-1.5 max-w-lg text-xs leading-relaxed">
                Mission responses, decisions, failures and important pull-request changes appear here.
              </p>
            </div>
        ) : (
          <section className="mt-4 overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
            <div className="divide-y divide-zinc-100 dark:divide-zinc-800/70" role="list" aria-label="Activity events">
              {shown.map((item) => (
                <NotificationRow key={item.id} notification={item} role="listitem" onClick={() => onOpen(item)} />
              ))}
            </div>
          </section>
        )}
        {hasMore ? (
          <div className="mt-4 flex justify-center">
            <button type="button" className="btn-ghost text-xs" onClick={onLoadMore}>Load older</button>
          </div>
        ) : null}
      </div>
    </main>
  );
}

function FilterButton({
  active,
  count,
  onClick,
  children,
}: {
  readonly active: boolean;
  readonly count?: number;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`flex cursor-pointer items-center gap-1.5 border-l border-zinc-200 px-4 text-xs first:border-l-0 dark:border-zinc-800 ${
        active ? 'bg-zinc-100 font-medium text-zinc-950 dark:bg-zinc-800 dark:text-zinc-50' : 'text-zinc-500 hover:text-zinc-900 dark:text-zinc-400'
      }`}
      onClick={onClick}
    >
      {children}
      {count ? <span className="tabular-nums text-[10px]">{count}</span> : null}
    </button>
  );
}
