import { slopBand, type SlopBandId } from '../detection-meta.js';

/** The bar's paint; which band a score falls in is decided in detection-meta. */
const BAND_FILL: Record<SlopBandId, string> = {
  high: 'bg-red-500 dark:bg-red-400',
  elevated: 'bg-amber-500 dark:bg-amber-400',
  low: 'bg-emerald-500 dark:bg-emerald-400',
};

/** The slop-o-meter: 0–100 AI likelihood as a compact tinted bar. Shared by
 *  the detections page and the dashboard radar widget (which must not pull in
 *  the lazy page chunk). `lg` is the detection page's headline reading: the
 *  score leads, and the bar takes whatever width it is given. */
export function SlopMeter({ value, size = 'sm' }: { value: number; size?: 'sm' | 'lg' }): JSX.Element {
  const title = `AI likelihood ${value}/100 — the agent's estimate of how likely this PR is AI-generated slop`;
  const fill = (
    <span className={`block h-full rounded-full ${BAND_FILL[slopBand(value).id]}`} style={{ width: `${value}%` }} />
  );
  if (size === 'lg') {
    return (
      <span className="flex items-center gap-3" title={title}>
        <span className="text-4xl leading-none font-semibold tabular-nums">{value}</span>
        <span className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">{fill}</span>
        <span className="sr-only">out of 100 AI likelihood</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2" title={title}>
      <span className="h-1.5 w-20 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">{fill}</span>
      <span className="w-6 text-right text-xs font-semibold tabular-nums">{value}</span>
      <span className="sr-only">out of 100 AI likelihood</span>
    </span>
  );
}
