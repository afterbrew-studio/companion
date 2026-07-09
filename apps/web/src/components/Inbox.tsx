import { useState } from 'react';
import type { NotificationKind, NotificationRecord } from '@companion/contract';
import { useNotifications } from '../hooks/useNotifications.js';
import { timeAgo } from './ui.js';

/**
 * The header bell: unread badge plus a popover of the *unread* items only —
 * a quick "what needs me right now". The full history (read included) lives on
 * the Inbox page, one click away via "View all".
 */

export const KIND_META: Record<NotificationKind, { icon: string; cls: string; label: string }> = {
  action_required: { icon: '●', cls: 'text-amber-600 dark:text-amber-400', label: 'action required' },
  finished: { icon: '✓', cls: 'text-emerald-600 dark:text-emerald-400', label: 'finished' },
  error: { icon: '✕', cls: 'text-red-600 dark:text-red-400', label: 'failed' },
  info: { icon: '●', cls: 'text-zinc-400 dark:text-zinc-500', label: 'info' },
};

export function Inbox(): JSX.Element {
  const { items, unread, markRead, markAllRead } = useNotifications();
  const [open, setOpen] = useState(false);
  // The bell is a triage surface: only what still needs a look.
  const unreadItems = items.filter((n) => n.readAt === null);

  const openItem = (n: NotificationRecord): void => {
    markRead(n.id);
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
            <button className="linkish text-xs" disabled={unread === 0} onClick={() => markAllRead()}>
              Mark all read
            </button>
          </div>
          <div className="max-h-96 overflow-y-auto" role="list" aria-label="Unread notifications">
            {unreadItems.map((n) => {
              const meta = KIND_META[n.kind];
              return (
                <button
                  key={n.id}
                  type="button"
                  role="listitem"
                  className="flex w-full cursor-pointer items-start gap-2.5 border-b border-zinc-100 px-3.5 py-2.5 text-left transition-colors last:border-b-0 hover:bg-zinc-50 dark:border-zinc-800/60 dark:hover:bg-zinc-800/60"
                  onClick={() => openItem(n)}
                >
                  <span className={`mt-0.5 w-3.5 shrink-0 text-center text-xs ${meta.cls}`} aria-hidden>
                    {meta.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="truncate text-[13px] font-medium">{n.title}</span>
                      <span className="dim ml-auto shrink-0 text-[11px]">{timeAgo(n.createdAt)}</span>
                    </span>
                    <span className="dim block truncate">{n.body}</span>
                  </span>
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-zinc-900 dark:bg-zinc-100" aria-label="unread" />
                </button>
              );
            })}
            {unreadItems.length === 0 ? (
              <div className="dim px-4 py-8 text-center">You&apos;re all caught up — nothing unread.</div>
            ) : null}
          </div>
          <a
            href="#/inbox"
            className="border-t border-zinc-200 px-3.5 py-2.5 text-center text-xs font-medium text-zinc-600 transition-colors hover:bg-zinc-50 hover:text-zinc-900 dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800/60 dark:hover:text-zinc-100"
            onClick={() => setOpen(false)}
          >
            View all notifications
          </a>
        </div>
      ) : null}
    </div>
  );
}
