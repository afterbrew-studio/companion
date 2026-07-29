import { Eyebrow, MetaSignal, Skeleton } from '@moxxy/companion-sdk/ui';
import type { SlopAppliedAction, SlopVerdict } from '../../contract/index.js';
import { ACTION_LABEL, SLOP_BANDS, slopBand, slopBandRange } from '../detection-meta.js';
import { SlopMeter } from './SlopMeter.js';

/**
 * The decision, in the order a maintainer needs it: the score and the band it
 * lands in, the confidence behind it, then the action to take. Unboxed on
 * purpose; the bordered card beside it carries facts read off GitHub, this
 * carries the agent's own reading.
 */
export function SlopScore({
  verdict,
  appliedAction,
}: {
  verdict: SlopVerdict;
  appliedAction: SlopAppliedAction | null;
}): JSX.Element {
  const band = slopBand(verdict.aiLikelihood);
  return (
    <div>
      <Eyebrow>AI likelihood</Eyebrow>
      <div className="mt-1.5">
        <SlopMeter value={verdict.aiLikelihood} size="lg" />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-2">
        <MetaSignal tone={band.tone} label={`${band.label} band`} />
        <span className="dim">
          {slopBandRange(band)} · {verdict.confidence} confidence
        </span>
      </div>
      <SlopBandLegend />
      <div className="mt-3">
        <Eyebrow>{appliedAction ? 'Applied' : 'Recommended'}</Eyebrow>
        <p className="mt-1 text-sm font-medium">{ACTION_LABEL[appliedAction ?? verdict.recommendedAction]}</p>
        {appliedAction && appliedAction !== verdict.recommendedAction ? (
          <p className="dim mt-0.5">recommended {ACTION_LABEL[verdict.recommendedAction]}</p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The score's shape while the agent is still scoring: same blocks, same
 * heights, so nothing moves when the verdict lands. The scale is known before
 * the score is, so the legend renders for real.
 */
export function SlopScoreSkeleton(): JSX.Element {
  return (
    <div>
      <Eyebrow>AI likelihood</Eyebrow>
      <div className="mt-1.5 flex items-center gap-3">
        <Skeleton className="h-9 w-14" />
        <Skeleton className="h-2 min-w-0 flex-1 rounded-full" />
      </div>
      <Skeleton className="mt-2 h-4 w-44" />
      <SlopBandLegend />
      <div className="mt-3">
        <Eyebrow>Recommended</Eyebrow>
        <Skeleton className="mt-1 h-5 w-28" />
      </div>
    </div>
  );
}

/** The scale, one click away: where each band starts and what it means. */
function SlopBandLegend(): JSX.Element {
  return (
    <details className="mt-1.5">
      <summary className="dim cursor-pointer select-none">What the bands mean</summary>
      <ul className="mt-1.5 flex flex-col gap-1">
        {SLOP_BANDS.map((band) => (
          <li key={band.id} className="flex flex-wrap items-baseline gap-x-2">
            {/* Fixed gutter so the three meanings line up under each other. */}
            <span className="w-32 shrink-0">
              <MetaSignal tone={band.tone} label={`${band.label}, ${slopBandRange(band)}`} />
            </span>
            <span className="dim">{band.meaning}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
