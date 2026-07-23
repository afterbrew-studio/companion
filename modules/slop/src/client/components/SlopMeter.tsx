/** The slop-o-meter: 0–100 AI likelihood as a compact tinted bar. Shared by
 *  the detections page and the dashboard radar widget (which must not pull in
 *  the lazy page chunk). */
export function SlopMeter({ value }: { value: number }): JSX.Element {
  const tone =
    value >= 70
      ? 'bg-red-500 dark:bg-red-400'
      : value >= 40
        ? 'bg-amber-500 dark:bg-amber-400'
        : 'bg-emerald-500 dark:bg-emerald-400';
  return (
    <span
      className="inline-flex items-center gap-2"
      title={`AI likelihood ${value}/100 — the agent's estimate of how likely this PR is AI-generated slop`}
    >
      <span className="h-1.5 w-20 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        <span className={`block h-full rounded-full ${tone}`} style={{ width: `${value}%` }} />
      </span>
      <span className="w-6 text-right text-xs font-semibold tabular-nums">{value}</span>
      <span className="sr-only">out of 100 AI likelihood</span>
    </span>
  );
}
