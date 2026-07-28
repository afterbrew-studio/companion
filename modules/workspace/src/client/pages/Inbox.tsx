import { useState } from 'react';
import { EmptyState, ListCard, Page, PageHeader, Tabs } from '@moxxy/companion-sdk/ui';
import type { NotificationRecord } from '../../contract/index.js';
import { NotificationRow } from '../components/NotificationRow.js';
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
        <ListCard subtle className="overflow-hidden">
          {shown.map((n) => (
            <NotificationRow key={n.id} notification={n} onClick={() => openItem(n)} />
          ))}
        </ListCard>
      )}
    </Page>
  );
}
