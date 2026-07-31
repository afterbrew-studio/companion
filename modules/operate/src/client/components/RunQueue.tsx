import { useState } from 'react';
import { CloseIcon, IconButton, timeAgo } from '@moxxy/companion-ui';
import type { QueuedRunEntry, RunKind } from '../../contract/index.js';
import { operateApi as api } from '../api.js';
import { useRunQueue } from '../hooks/useRunQueue.js';
import { useRunnerCapacity } from '../hooks/useRunnerCapacity.js';

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
  command: 'Command',
};

/** Persistent shell banner while the viewer's whole eligible pool is full. */
export function RunnerCapacityBanner(): JSX.Element | null {
  const { active, capacity } = useRunnerCapacity();
  if (active < capacity) return null;
  return (
    <div
      className="flex shrink-0 items-center gap-2 border-b border-amber-300/70 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
      role="status"
      aria-live="polite"
    >
      <span className="size-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden />
      <span>
        <strong>Runner pool is at capacity.</strong> New automated tasks will wait and start automatically as soon as a
        slot becomes free.
      </span>
      <span className="ml-auto shrink-0 tabular-nums">
        {active} / {capacity} busy
      </span>
    </div>
  );
}

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
          <span className="chip normal-case">{KIND_LABEL[entry.kind]}</span>
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
          <ChevronGlyph d="M4 10l4-4 4 4" />
        </IconButton>
        <IconButton
          label="Move down"
          disabled={last}
          onClick={() => void api.moveQueued(entry.id, 'down').catch(() => undefined)}
        >
          <ChevronGlyph d="M4 6l4 4 4-4" />
        </IconButton>
        <IconButton
          label="Cancel"
          danger
          onClick={() => void api.cancelQueued(entry.id).catch(() => undefined)}
        >
          <CloseIcon />
        </IconButton>
      </div>
    </div>
  );
}

/** Reorder chevrons — direction-only variants, so not worth a shared glyph. */
function ChevronGlyph({ d }: { d: string }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="size-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
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
