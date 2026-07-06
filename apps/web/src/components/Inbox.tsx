import { useCallback, useEffect, useState } from 'react';
import type { NotificationKind, NotificationRecord } from '@companion/contract';
import { api, onServerMessage } from '../lib/api.js';
import { useWorkspace } from '../lib/workspace.js';
import { timeAgo } from './ui.js';

/**
 * The inbox: bell + unread badge in the header, popover panel listing what the
 * workspaces reported — action required, finished operations, failures.
 */

const KIND_META: Record<NotificationKind, { icon: string; cls: string; label: string }> = {
  action_required: { icon: '●', cls: 'text-amber-600 dark:text-amber-400', label: 'action required' },
  finished: { icon: '✓', cls: 'text-emerald-600 dark:text-emerald-400', label: 'finished' },
  error: { icon: '✕', cls: 'text-red-600 dark:text-red-400', label: 'failed' },
  info: { icon: '●', cls: 'text-zinc-400 dark:text-zinc-500', label: 'info' },
};

export function Inbox(): JSX.Element {
  const { current } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationRecord[]>([]);

  const refresh = useCallback(async () => {
    try {
      const { notifications } = await api.listNotifications(current?.id);
      setItems(notifications);
    } catch {
      // signed-out or transient — the badge just stays empty
    }
  }, [current?.id]);

  useEffect(() => {
    void refresh();
    return onServerMessage((msg) => {
      if (msg.t === 'notifications.changed') void refresh();
    });
  }, [refresh]);

  const unread = items.filter((n) => n.readAt === null).length;

  const openItem = (n: NotificationRecord): void => {
    if (n.readAt === null) void api.markNotificationRead(n.id).catch(() => undefined);
    setOpen(false);
    if (n.href) location.hash = n.href;
  };

  return (
    <div
      className="relative"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        type="button"
        className="dim relative flex cursor-pointer items-center rounded-lg border border-zinc-200 p-1.5 transition-colors hover:bg-zinc-100 hover:text-zinc-800 dark:border-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        aria-label={`Inbox — ${unread} unread`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden>
          <path
            d="M8 2a4 4 0 0 0-4 4v2.5L2.8 10.8a.6.6 0 0 0 .5.95h9.4a.6.6 0 0 0 .5-.95L12 8.5V6a4 4 0 0 0-4-4zM6.5 13.5a1.5 1.5 0 0 0 3 0"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {unread > 0 ? (
          <span className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-semibold text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute top-full right-0 z-40 mt-1.5 flex w-96 flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl max-sm:w-80 dark:border-zinc-700 dark:bg-zinc-900">
          <div className="flex items-center justify-between border-b border-zinc-200 px-3.5 py-2.5 dark:border-zinc-800">
            <span className="text-[13px] font-semibold">Inbox</span>
            <button
              className="linkish text-xs"
              disabled={unread === 0}
              onClick={() => void api.markAllNotificationsRead(current?.id).catch(() => undefined)}
            >
              Mark all read
            </button>
          </div>
          <div className="max-h-96 overflow-y-auto" role="list" aria-label="Notifications">
            {items.map((n) => {
              const meta = KIND_META[n.kind];
              return (
                <button
                  key={n.id}
                  type="button"
                  role="listitem"
                  className={`flex w-full cursor-pointer items-start gap-2.5 border-b border-zinc-100 px-3.5 py-2.5 text-left transition-colors last:border-b-0 hover:bg-zinc-50 dark:border-zinc-800/60 dark:hover:bg-zinc-800/60 ${
                    n.readAt !== null ? 'opacity-60' : ''
                  }`}
                  onClick={() => openItem(n)}
                >
                  <span className={`mt-0.5 w-3.5 shrink-0 text-center text-xs ${meta.cls}`} aria-hidden>
                    {meta.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className={`truncate text-[13px] ${n.readAt === null ? 'font-medium' : ''}`}>
                        {n.title}
                      </span>
                      <span className="dim ml-auto shrink-0 text-[11px]">{timeAgo(n.createdAt)}</span>
                    </span>
                    <span className="dim block truncate">{n.body}</span>
                  </span>
                  {n.readAt === null ? (
                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-zinc-900 dark:bg-zinc-100" aria-label="unread" />
                  ) : null}
                </button>
              );
            })}
            {items.length === 0 ? (
              <div className="dim px-4 py-8 text-center">Nothing here yet — finished runs and action-required events land in this inbox.</div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
