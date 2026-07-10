import { useState } from 'react';
import { EmptyState, Page, PageHeader, Tabs, timeAgo } from '@companion/ui';
import type { NotificationRecord } from '../../contract/index.js';
import { KIND_META } from '../components/Inbox.js';
import { useNotifications } from '../hooks/useNotifications.js';
import { useWorkspace } from '../lib/workspace.js';

type Filter = 'all' | 'unread';

/**
 * The full notification history — read and unread — for whatever scope the
 * user's preference resolves to. The header bell is the unread-only shortcut;
 * this is the archive.
 */
export function InboxPage(): JSX.Element {
  const { items, unread, scope, markRead, markAllRead } = useNotifications();
  const { current } = useWorkspace();
  const [filter, setFilter] = useState<Filter>('all');

  const shown = filter === 'unread' ? items.filter((n) => n.readAt === null) : items;

  const scopeHint =
    scope === 'global'
      ? 'Showing notifications from every workspace you can access.'
      : `Showing ${current?.name ?? 'the active workspace'} — switch workspace to see its inbox, or change scope in your profile.`;

  const openItem = (n: NotificationRecord): void => {
    markRead(n.id);
    if (n.href) location.hash = n.href;
  };

  return (
    <Page>
      <PageHeader
        title="Inbox"
        subtitle={scopeHint}
        actions={
          <button className="btn-ghost" disabled={unread === 0} onClick={() => markAllRead()}>
            Mark all read
          </button>
        }
      />

      <div className="mb-4">
        <Tabs<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All', count: items.length },
            { value: 'unread', label: 'Unread', count: unread },
          ]}
        />
      </div>

      {shown.length === 0 ? (
        <EmptyState
          title={filter === 'unread' ? 'Nothing unread' : 'No notifications yet'}
          hint="Finished runs, action-required events, and failures land here."
        />
      ) : (
        <ul className="divide-y divide-zinc-100 overflow-hidden rounded-xl border border-zinc-200 dark:divide-zinc-800/60 dark:border-zinc-800">
          {shown.map((n) => {
            const meta = KIND_META[n.kind];
            const unreadRow = n.readAt === null;
            return (
              <li key={n.id}>
                <button
                  type="button"
                  className={`flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/60 ${
                    unreadRow ? '' : 'opacity-60'
                  }`}
                  onClick={() => openItem(n)}
                >
                  <span
                    className={`mt-0.5 w-4 shrink-0 text-center text-sm ${meta.cls}`}
                    aria-label={meta.label}
                    title={meta.label}
                  >
                    {meta.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className={`truncate text-sm ${unreadRow ? 'font-medium' : ''}`}>{n.title}</span>
                      <span className="dim ml-auto shrink-0 text-[11px]">{timeAgo(n.createdAt)}</span>
                    </span>
                    {n.body ? <span className="dim mt-0.5 block text-[13px]">{n.body}</span> : null}
                  </span>
                  {unreadRow ? (
                    <span
                      className="mt-1.5 size-1.5 shrink-0 rounded-full bg-zinc-900 dark:bg-zinc-100"
                      aria-label="unread"
                    />
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Page>
  );
}
