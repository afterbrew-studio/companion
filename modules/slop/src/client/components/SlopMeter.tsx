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
    <span className="inline-flex items-center gap-1.5" title={`slop-o-meter: ${value}/100`}>
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        <span className={`block h-full rounded-full ${tone}`} style={{ width: `${value}%` }} />
      </span>
      <span className="text-xs font-medium tabular-nums">{value}</span>
    </span>
  );
}
