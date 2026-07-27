import { timeAgo } from '@moxxy-ai/companion-sdk/ui';
import type { NotificationKind, NotificationRecord } from '../../contract/index.js';

/** Leading glyph + tone per notification kind, shared by the bell popover and the Inbox page. */
export const KIND_META: Record<NotificationKind, { icon: string; cls: string; label: string }> = {
  action_required: { icon: '●', cls: 'text-amber-600 dark:text-amber-400', label: 'action required' },
  finished: { icon: '✓', cls: 'text-emerald-600 dark:text-emerald-400', label: 'finished' },
  error: { icon: '✕', cls: 'text-red-600 dark:text-red-400', label: 'failed' },
  info: { icon: '●', cls: 'text-zinc-400 dark:text-zinc-500', label: 'info' },
};

/**
 * One notification row — kind glyph, title + age, dim body, trailing unread
 * dot — rendered at two scales: `compact` for the bell popover, default for
 * the Inbox page. Dividers come from the surrounding list container.
 */
export function NotificationRow({
  notification: n,
  compact,
  onClick,
  role,
}: {
  notification: NotificationRecord;
  compact?: boolean;
  onClick: () => void;
  role?: string;
}): JSX.Element {
  const meta = KIND_META[n.kind];
  const unread = n.readAt === null;

  return (
    <button
      type="button"
      role={role}
      className={`flex w-full cursor-pointer items-start text-left transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/60 ${
        compact ? 'gap-2.5 px-3.5 py-2.5' : 'gap-3 px-4 py-3'
      } ${unread ? '' : 'opacity-60'}`}
      onClick={onClick}
    >
      <span
        className={`mt-0.5 shrink-0 text-center ${compact ? 'w-3.5 text-xs' : 'w-4 text-sm'} ${meta.cls}`}
        aria-label={meta.label}
        title={meta.label}
      >
        {meta.icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={`truncate ${compact ? 'text-[13px]' : 'text-sm'} ${unread ? 'font-medium' : ''}`}>
            {n.title}
          </span>
          <span className="dim ml-auto shrink-0 text-[11px]">{timeAgo(n.createdAt)}</span>
        </span>
        {n.body ? <span className={`dim mt-0.5 block ${compact ? 'truncate' : 'text-[13px]'}`}>{n.body}</span> : null}
      </span>
      {unread ? (
        <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-zinc-900 dark:bg-zinc-100" aria-label="unread" />
      ) : null}
    </button>
  );
}
