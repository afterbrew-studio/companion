import { useState } from 'react';
import { timeAgo } from '@companion/ui';
import type { QueuedRunEntry, RunKind } from '../../contract/index.js';
import { operateApi as api } from '../api.js';
import { useRunQueue } from '../hooks/useRunQueue.js';

/**
 * Header indicator for the run scheduler: appears only when runners are at
 * capacity or work is waiting. Opens a panel to watch, reorder, and cancel the
 * queue of unattended agent runs (triage, review, analysis, …).
 */

const KIND_LABEL: Record<RunKind, string> = {
  interactive: 'Chat',
  assistant: 'AI Help',
  triage: 'Triage',
  fix: 'Fix',
  analysis: 'Review',
  implement: 'Implement',
  report: 'Report',
};

export function RunQueueIndicator(): JSX.Element | null {
  const { active, capacity, entries } = useRunQueue();
  const [open, setOpen] = useState(false);

  const busy = active >= capacity;
  const waiting = entries.length;
  // Nothing interesting to show: capacity to spare and an empty line.
  if (!busy && waiting === 0) return null;

  const label = waiting > 0 ? `${waiting} queued` : 'runners busy';

  return (
    <div
      className="relative"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        type="button"
        className="dim flex cursor-pointer items-center gap-2 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-xs transition-colors hover:bg-zinc-100 hover:text-zinc-800 dark:border-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        aria-label={`Run queue — ${active} of ${capacity} runners busy, ${waiting} queued`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="flex items-center gap-1" aria-hidden>
          <ClockIcon />
          <span className="font-medium tabular-nums">{label}</span>
        </span>
      </button>

      {open ? (
        <div className="absolute top-full right-0 z-40 mt-1.5 flex w-96 flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl max-sm:w-80 dark:border-zinc-700 dark:bg-zinc-900">
          <div className="flex items-center justify-between border-b border-zinc-200 px-3.5 py-2.5 dark:border-zinc-800">
            <span className="text-[13px] font-semibold">Run queue</span>
            <span className="dim text-[11px] tabular-nums">
              {active} / {capacity} runner slots busy
            </span>
          </div>
          <div className="max-h-96 overflow-y-auto" role="list" aria-label="Queued runs">
            {entries.map((e, i) => (
              <QueueRow key={e.id} entry={e} first={i === 0} last={i === entries.length - 1} />
            ))}
            {entries.length === 0 ? (
              <div className="dim px-4 py-8 text-center">
                All runners are busy. New agent actions will queue here and start as slots free up.
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function QueueRow({ entry, first, last }: { entry: QueuedRunEntry; first: boolean; last: boolean }): JSX.Element {
  const target = entry.repo ? `${entry.repo}${entry.issueNumber ? ` #${entry.issueNumber}` : ''}` : null;
  return (
    <div
      role="listitem"
      className="flex items-center gap-2 border-b border-zinc-100 px-3 py-2 last:border-b-0 dark:border-zinc-800/60"
    >
      <span className="dim w-5 shrink-0 text-center text-[11px] tabular-nums">{entry.position + 1}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium dark:bg-zinc-800">
            {KIND_LABEL[entry.kind]}
          </span>
          <span className="truncate text-[13px]">{entry.title}</span>
        </span>
        <span className="dim block truncate text-[11px]">
          {target ? `${target} · ` : ''}queued {timeAgo(entry.enqueuedAt)}
        </span>
      </span>
      <div className="flex shrink-0 items-center gap-0.5">
        <IconButton
          label="Move up"
          disabled={first}
          onClick={() => void api.moveQueued(entry.id, 'up').catch(() => undefined)}
        >
          <path d="M4 10l4-4 4 4" />
        </IconButton>
        <IconButton
          label="Move down"
          disabled={last}
          onClick={() => void api.moveQueued(entry.id, 'down').catch(() => undefined)}
        >
          <path d="M4 6l4 4 4-4" />
        </IconButton>
        <IconButton
          label="Cancel"
          danger
          onClick={() => void api.cancelQueued(entry.id).catch(() => undefined)}
        >
          <path d="M4 4l8 8M12 4l-8 8" />
        </IconButton>
      </div>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`flex size-6 cursor-pointer items-center justify-center rounded transition-colors disabled:cursor-default disabled:opacity-30 ${
        danger
          ? 'text-zinc-500 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10 dark:hover:text-red-400'
          : 'text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200'
      }`}
    >
      <svg viewBox="0 0 16 16" fill="none" className="size-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {children}
      </svg>
    </button>
  );
}

function ClockIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="size-3.5" stroke="currentColor" strokeWidth="1.3" aria-hidden>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5v3l2 1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
