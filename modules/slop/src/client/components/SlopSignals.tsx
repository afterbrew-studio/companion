import { ListCard, MetaSignal, RowsSkeleton } from '@moxxy/companion-sdk/ui';
import type { SlopSignal } from '../../contract/index.js';
import { STRENGTH_TONE, rankSignals } from '../detection-meta.js';

/**
 * Which rules fired and how hard, one row each, strongest first. The
 * observation is the long part, so it waits behind the row's own disclosure:
 * the scan is the strengths, the reading is whichever rows earn it. The page
 * titles the block, so this renders the list alone.
 */
export function SlopSignals({ signals }: { signals: ReadonlyArray<SlopSignal> }): JSX.Element {
  return (
    <ListCard ariaLabel="Signals, strongest first">
      {rankSignals(signals).map((signal, i) => (
        <details key={`${signal.ruleId}-${i}`} className="group">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 transition-colors select-none hover:bg-zinc-50 dark:hover:bg-zinc-900">
            <span className="w-20 shrink-0">
              <MetaSignal tone={STRENGTH_TONE[signal.strength]} label={signal.strength} />
            </span>
            <span className="min-w-0 truncate text-[13px] font-medium">{signal.ruleName}</span>
            {/* A first glance at the evidence. Both variants hide it, so their
                order in the stylesheet cannot resurrect it beside the full text. */}
            <span className="dim min-w-0 flex-1 truncate group-open:hidden max-sm:hidden">{signal.observation}</span>
            <svg
              viewBox="0 0 16 16"
              className="ml-auto size-3.5 shrink-0 text-zinc-400 transition-transform group-open:rotate-180"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M4 6l4 4 4-4" />
            </svg>
          </summary>
          {/* Indented to the rule name it belongs to: px-4 + the w-20 gutter + gap-2. */}
          <p className="px-4 pb-3.5 text-[13px] leading-relaxed wrap-anywhere sm:pl-26">{signal.observation}</p>
        </details>
      ))}
    </ListCard>
  );
}

/** Signals while the agent is still scoring: the count is unknown too. */
export function SlopSignalsSkeleton(): JSX.Element {
  return (
    <ListCard>
      <RowsSkeleton rows={3} />
    </ListCard>
  );
}
