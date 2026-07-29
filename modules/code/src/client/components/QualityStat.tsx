import { MetaSignal } from '@moxxy/companion-sdk/ui';
import type { AgentQualityStat } from '../../contract/index.js';

/**
 * One agent surface's card. Exported so a module contributing through the
 * `quality.panels` slot renders identically to the built-in ones instead of
 * inventing its own layout.
 */
export function QualityStat({ stat }: { stat: AgentQualityStat }): JSX.Element {
  const decided = stat.accepted + stat.rejected;
  const rate = stat.acceptanceRate;
  // Three bands rather than a gradient: the question a maintainer is asking is
  // "can I trust this surface", and that has three useful answers.
  const tone = rate === null ? 'zinc' : rate >= 0.8 ? 'green' : rate >= 0.5 ? 'amber' : 'red';

  return (
    <div className="card flex flex-col gap-2 p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold">{stat.label}</h3>
        {rate === null ? (
          <MetaSignal tone="zinc" label="no decisions yet" />
        ) : (
          <span className="text-lg font-semibold tabular-nums">{Math.round(rate * 100)}%</span>
        )}
      </div>
      <p className="dim text-xs">
        {rate === null
          ? 'Nobody has accepted or dismissed a verdict from this surface yet.'
          : `${stat.accepted} of ${decided} decided verdicts were accepted.`}
      </p>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
        <Row label="Accepted" value={stat.accepted} />
        <Row label="Dismissed" value={stat.rejected} />
        <Row label="Awaiting you" value={stat.pending} />
        {/* Reliability, not judgement: an agent that crashed was never rejected. */}
        <Row label="Produced nothing" value={stat.failed} tone={stat.failed > 0 ? 'warn' : undefined} />
        {stat.overridden !== null ? (
          <Row
            label="Action softened"
            value={stat.overridden}
            title="The finding was accepted but a human applied something other than the recommended action."
          />
        ) : null}
      </dl>
    </div>
  );
}

function Row({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: number;
  tone?: 'warn';
  title?: string;
}): JSX.Element {
  return (
    <>
      <dt className="dim" title={title}>
        {label}
      </dt>
      <dd
        className={`text-right tabular-nums ${tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : ''}`}
        title={title}
      >
        {value}
      </dd>
    </>
  );
}
