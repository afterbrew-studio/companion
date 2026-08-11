import { StatusGlyph } from '@moxxy/companion-sdk/ui';
import type { AgentQualityStat } from '../../contract/index.js';

/**
 * Whether a surface has produced anything worth reporting on. A surface with no
 * verdicts at all is not a 0% surface, and the page leans on this to say so once
 * rather than once per card.
 */
export function hasQualitySignal(stat: AgentQualityStat): boolean {
  return stat.accepted + stat.rejected + stat.pending + stat.failed + (stat.cancelled ?? 0) > 0;
}

/**
 * Three bands rather than a gradient: the question a maintainer is asking is
 * "can I trust this surface", and that has three useful answers. The word is
 * carried alongside the colour, never by it — a red bar means nothing to a
 * reader who cannot see red.
 */
function band(rate: number | null): { tone: 'ok' | 'warn' | 'danger' | 'muted'; word: string } {
  if (rate === null) return { tone: 'muted', word: 'not yet judged' };
  if (rate >= 0.8) return { tone: 'ok', word: 'trusted' };
  if (rate >= 0.5) return { tone: 'warn', word: 'mixed' };
  return { tone: 'danger', word: 'often wrong' };
}

const FILL: Record<'ok' | 'warn' | 'danger' | 'muted', string> = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  danger: 'bg-red-500',
  muted: 'bg-zinc-400',
};
// A lighter step of the fill's own ramp, so the band reads across the whole bar
// rather than only across the filled part.
const TRACK: Record<'ok' | 'warn' | 'danger' | 'muted', string> = {
  ok: 'bg-emerald-500/15',
  warn: 'bg-amber-500/15',
  danger: 'bg-red-500/15',
  muted: 'bg-zinc-400/15',
};

const TEXT: Record<'ok' | 'warn' | 'danger' | 'muted', string> = {
  ok: 'text-emerald-600 dark:text-emerald-400',
  warn: 'text-amber-600 dark:text-amber-400',
  danger: 'text-red-600 dark:text-red-400',
  muted: 'dim',
};

/**
 * One agent surface, as a row.
 *
 * A row rather than a card because the page holds two or three of these and a
 * grid of cards left two thirds of the width empty. Exported so a module
 * contributing through the `quality.panels` slot renders identically instead of
 * inventing its own layout.
 */
export function QualityStat({ stat }: { stat: AgentQualityStat }): React.JSX.Element {
  const decided = stat.accepted + stat.rejected;
  const rate = stat.acceptanceRate;
  const { tone, word } = band(rate);
  const pct = rate === null ? 0 : Math.round(rate * 100);
  const cancelled = stat.cancelled ?? 0;

  return (
    <div className="card flex flex-col gap-2.5 p-4" aria-label={stat.label}>
      <div className="flex items-center gap-2">
        <StatusGlyph tone={tone} label={word} />
        <h3 className="min-w-0 flex-1 truncate text-sm font-semibold">{stat.label}</h3>
        {rate === null ? (
          <span className="dim text-xs">{word}</span>
        ) : (
          <>
            {/* Proportional figures on purpose: tabular-nums is for columns that
                must align, and gives a standalone display number loose spacing. */}
            <span className={`text-2xl font-semibold leading-none ${TEXT[tone]}`}>{pct}%</span>
            <span className="dim text-xs">{word}</span>
          </>
        )}
      </div>

      <div
        className={`h-1.5 w-full overflow-hidden rounded-full ${TRACK[tone]}`}
        role="img"
        aria-label={
          rate === null
            ? `${stat.label}: no decisions yet`
            : `${stat.label}: ${stat.accepted} of ${decided} decided verdicts accepted`
        }
      >
        {rate === null ? null : (
          <div className={`h-full rounded-full ${FILL[tone]}`} style={{ width: `${Math.max(pct, 2)}%` }} />
        )}
      </div>

      <p className="dim text-xs">
        {rate === null ? (
          stat.pending > 0 ? (
            <>
              {stat.pending} verdict{stat.pending === 1 ? '' : 's'} waiting on a decision
            </>
          ) : (
            'No verdicts yet.'
          )
        ) : (
          <>
            {stat.accepted} of {decided} accepted
            {stat.pending > 0 ? ` · ${stat.pending} awaiting you` : ''}
            {stat.overridden ? ` · ${stat.overridden} softened` : ''}
          </>
        )}
        {/* Reliability, not judgement: an agent that crashed was never rejected,
            so it is called out separately rather than folded into the rate. */}
        {stat.failed > 0 ? (
          <span className="text-amber-600 dark:text-amber-400">
            {' · '}
            {stat.failed} produced nothing
          </span>
        ) : null}
        {cancelled > 0 ? <span className="dim"> · {cancelled} stopped</span> : null}
      </p>
    </div>
  );
}
