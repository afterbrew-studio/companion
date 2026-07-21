import { useMemo, useState } from 'react';
import { ChartSkeleton, formatTokens } from '@companion/ui';
import type { TokenUsageDay, TokenUsageModel } from '../../contract/index.js';
import { useTokenUsage } from '../hooks/useTokenUsage.js';
import { estimateUsd, formatUsd } from '../model-pricing.js';

// Two-series categorical palette (dataviz slots 1+2), validated per mode on the
// app surfaces — the same pair the dashboard's velocity charts wear. The light
// green sits below 3:1 contrast, so the data-table view is the required relief.
const IN_STROKE = 'stroke-[#2a78d6] dark:stroke-[#3987e5]';
const OUT_STROKE = 'stroke-[#1baf7a] dark:stroke-[#199e70]';
const IN_FILL = 'fill-[#2a78d6] dark:fill-[#3987e5]';
const OUT_FILL = 'fill-[#1baf7a] dark:fill-[#199e70]';
const IN_KEY = 'bg-[#2a78d6] dark:bg-[#3987e5]';
const OUT_KEY = 'bg-[#1baf7a] dark:bg-[#199e70]';

/**
 * Token burn & cost over the last 14 days — the `dashboard.widgets` slot
 * contribution. A stat strip (total, burn rate, projection, spend), a two-line
 * daily chart with crosshair readout, and a per-model spend table. Self-
 * contained: fetches its own aggregates and stays live over the WS loop.
 */
export function TokenBurnWidget(): JSX.Element | null {
  const { usage, error, retry } = useTokenUsage();

  // A failed load renders as a visible failure with a retry — hiding the
  // section made "the fetch raced a daemon restart" look like a missing chart.
  if (usage === null && error !== null) {
    return (
      <section className="mt-6" aria-labelledby="token-burn-heading">
        <h2 id="token-burn-heading" className="mb-2 text-sm font-semibold">
          Token burn &amp; cost
        </h2>
        <div className="card flex flex-wrap items-center gap-3 p-4 text-sm">
          <span className="text-red-600 dark:text-red-400">Couldn&apos;t load token usage: {error}</span>
          <button className="btn-ghost" onClick={retry}>
            Retry
          </button>
        </div>
      </section>
    );
  }

  if (usage === null) {
    return (
      <section className="mt-6" aria-labelledby="token-burn-heading" aria-busy>
        <h2 id="token-burn-heading" className="mb-2 text-sm font-semibold">
          Token burn &amp; cost
        </h2>
        <div className="grid gap-3 lg:grid-cols-2">
          <ChartSkeleton title="Tokens per day — last 14 days" />
          <ChartSkeleton title="Models — estimated spend" />
        </div>
      </section>
    );
  }

  const { days, models } = usage;
  const total = days.reduce((acc, d) => acc + d.inputTokens + d.outputTokens, 0);
  if (total === 0) return null;

  return (
    <section className="mt-6" aria-labelledby="token-burn-heading">
      <h2 id="token-burn-heading" className="mb-2 text-sm font-semibold">
        Token burn &amp; cost <span className="dim font-normal">· last 14 days</span>
      </h2>
      <StatStrip days={days} models={models} total={total} />
      <div className="mt-3 grid items-stretch gap-3 lg:grid-cols-2">
        <BurnChart days={days} />
        <ModelSpendCard models={models} />
      </div>
    </section>
  );
}

// ---------- headline stats --------------------------------------------------------

/**
 * The numbers a cost section leads with: total, current burn rate (with its
 * week-over-week direction), the month projection, and estimated spend.
 */
function StatStrip({
  days,
  models,
  total,
}: {
  days: ReadonlyArray<TokenUsageDay>;
  models: ReadonlyArray<TokenUsageModel>;
  total: number;
}): JSX.Element {
  const last7 = days.slice(-7);
  const prev7 = days.slice(-14, -7);
  const sum = (list: ReadonlyArray<TokenUsageDay>): number =>
    list.reduce((acc, d) => acc + d.inputTokens + d.outputTokens, 0);
  const dailyTokens = last7.length > 0 ? sum(last7) / last7.length : 0;
  const prevDaily = prev7.length > 0 ? sum(prev7) / prev7.length : 0;
  const deltaPct = prevDaily > 0 ? ((dailyTokens - prevDaily) / prevDaily) * 100 : null;

  const knownCost = models.reduce((acc, m) => acc + (estimateUsd(m.model, m.inputTokens, m.outputTokens) ?? 0), 0);
  const pricedTokens = models.reduce(
    (acc, m) => acc + (estimateUsd(m.model, 1, 1) !== null ? m.inputTokens + m.outputTokens : 0),
    0,
  );
  const partial = models.some(
    (m) => estimateUsd(m.model, 1, 1) === null && m.inputTokens + m.outputTokens > 0,
  );
  // Trailing-7-day burn extrapolated to a month at the window's blended
  // $/token — a direction indicator, not a bill.
  const monthlyTokens = dailyTokens * 30;
  const monthlyCost = pricedTokens > 0 ? monthlyTokens * (knownCost / pricedTokens) : null;

  const stats: Array<{ label: string; value: string; note?: string; delta?: { pct: number } }> = [
    { label: 'Tokens · 14d', value: formatTokens(total) },
    {
      label: 'Burn rate · 7d avg',
      value: `${formatTokens(Math.round(dailyTokens))}/day`,
      ...(deltaPct !== null ? { delta: { pct: deltaPct } } : {}),
    },
    {
      label: 'Projected · 30d',
      value: monthlyCost !== null ? `≈ ${formatUsd(monthlyCost)}` : `≈ ${formatTokens(Math.round(monthlyTokens))}`,
      note: 'at the current mix',
    },
    {
      label: 'Est. spend · 14d',
      value: knownCost > 0 ? `${partial ? '≥ ' : ''}${formatUsd(knownCost)}` : '—',
      ...(partial || knownCost === 0 ? { note: 'unpriced models excluded' } : {}),
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {stats.map((s) => (
        <div key={s.label} className="card px-3 py-2.5">
          <div className="dim text-[11px]">{s.label}</div>
          <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
            <span className="text-lg leading-tight font-semibold">{s.value}</span>
            {s.delta ? (
              // Burn going up costs money: up wears the warning tone, down the good one.
              <span
                className={`text-[11px] font-medium ${
                  s.delta.pct >= 0 ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'
                }`}
              >
                {s.delta.pct >= 0 ? '▲' : '▼'} {Math.abs(s.delta.pct).toFixed(0)}% <span className="dim font-normal">vs prior 7d</span>
              </span>
            ) : null}
            {s.note ? <span className="dim text-[11px]">{s.note}</span> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------- the burn line chart ---------------------------------------------------

const dayLabel = (ts: number): string => new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/** Smallest "clean" ceiling (1/2/2.5/5 × 10^n) at or above the data max. */
function niceCeil(max: number): number {
  if (max <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(max));
  for (const f of [1, 2, 2.5, 5, 10]) {
    if (f * pow >= max) return f * pow;
  }
  return 10 * pow;
}

function BurnChart({ days }: { days: ReadonlyArray<TokenUsageDay> }): JSX.Element {
  const [hover, setHover] = useState<number | null>(null);
  const width = 520;
  const height = 190;
  const pad = { top: 14, right: 48, bottom: 22, left: 40 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const baseline = pad.top + plotH;
  const yMax = niceCeil(Math.max(...days.map((d) => Math.max(d.inputTokens, d.outputTokens)), 1));
  const x = (i: number): number => pad.left + (days.length > 1 ? (i / (days.length - 1)) * plotW : plotW / 2);
  const y = (v: number): number => baseline - (v / yMax) * plotH;

  const { linePath, areaPath } = useMemo(() => {
    const path = (pick: (d: TokenUsageDay) => number): { line: string; area: string } => {
      const pts = days.map((d, i) => `${x(i).toFixed(1)},${y(pick(d)).toFixed(1)}`);
      const line = `M${pts.join('L')}`;
      const area = `${line}L${x(days.length - 1).toFixed(1)},${baseline}L${x(0).toFixed(1)},${baseline}Z`;
      return { line, area };
    };
    return {
      linePath: { in: path((d) => d.inputTokens).line, out: path((d) => d.outputTokens).line },
      areaPath: { in: path((d) => d.inputTokens).area, out: path((d) => d.outputTokens).area },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  // Crosshair snapping: pointer position → nearest day index.
  const snap = (e: React.PointerEvent<SVGSVGElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * width;
    const i = Math.round(((px - pad.left) / plotW) * (days.length - 1));
    setHover(Math.max(0, Math.min(days.length - 1, i)));
  };

  const last = days[days.length - 1]!;
  // Endpoint labels only when the two line-ends don't collide — otherwise the
  // legend and crosshair carry it (marks rule: never stack colliding labels).
  const endsApart = Math.abs(y(last.inputTokens) - y(last.outputTokens)) >= 14;
  const hovered = hover !== null ? days[hover] : undefined;

  return (
    <figure className="card flex h-full flex-col">
      <figcaption className="flex flex-wrap items-center gap-3 text-[13px] font-medium">
        Tokens per day
        <span className="dim ml-auto flex items-center gap-3 font-normal">
          <span className="flex items-center gap-1.5">
            <span className={`inline-block h-0.5 w-3 rounded-full ${IN_KEY}`} aria-hidden />
            input
          </span>
          <span className="flex items-center gap-1.5">
            <span className={`inline-block h-0.5 w-3 rounded-full ${OUT_KEY}`} aria-hidden />
            output
          </span>
        </span>
      </figcaption>
      <div className="relative flex-1">
        {hovered ? (
          <div
            className="pointer-events-none absolute -top-1 z-10 -translate-x-1/2 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs shadow-md dark:border-zinc-700 dark:bg-zinc-900"
            style={{ left: `${Math.min(84, Math.max(16, (x(hover!) / width) * 100))}%` }}
            role="status"
          >
            <div className="dim">{dayLabel(hovered.dayStart)}</div>
            <div className="mt-0.5 font-semibold whitespace-nowrap">
              {formatTokens(hovered.inputTokens + hovered.outputTokens)} <span className="dim font-normal">total</span>
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 whitespace-nowrap">
              <span className={`inline-block h-0.5 w-3 rounded-full ${IN_KEY}`} aria-hidden />
              <span className="font-medium tabular-nums">{formatTokens(hovered.inputTokens)}</span>
              <span className="dim">input</span>
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 whitespace-nowrap">
              <span className={`inline-block h-0.5 w-3 rounded-full ${OUT_KEY}`} aria-hidden />
              <span className="font-medium tabular-nums">{formatTokens(hovered.outputTokens)}</span>
              <span className="dim">output</span>
            </div>
          </div>
        ) : null}
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="mt-1 w-full"
          role="img"
          aria-label={`Daily input and output tokens for the last ${days.length} days`}
          onPointerMove={snap}
          onPointerLeave={() => setHover(null)}
        >
          {/* recessive hairline grid with clean ticks */}
          {[0.5, 1].map((f) => (
            <g key={f}>
              <line
                x1={pad.left}
                x2={width - pad.right}
                y1={y(yMax * f)}
                y2={y(yMax * f)}
                className="stroke-zinc-200 dark:stroke-zinc-800"
                strokeWidth={1}
              />
              <text
                x={pad.left - 6}
                y={y(yMax * f) + 3}
                textAnchor="end"
                className="fill-zinc-400 text-[9px] tabular-nums dark:fill-zinc-500"
              >
                {formatTokens(yMax * f)}
              </text>
            </g>
          ))}
          <line
            x1={pad.left}
            x2={width - pad.right}
            y1={baseline}
            y2={baseline}
            className="stroke-zinc-300 dark:stroke-zinc-700"
            strokeWidth={1}
          />
          {/* x labels: every other day, the last always */}
          {days.map((d, i) =>
            i % 2 === (days.length - 1) % 2 ? (
              <text
                key={d.dayStart}
                x={x(i)}
                y={height - 6}
                textAnchor="middle"
                className="fill-zinc-400 text-[9px] dark:fill-zinc-500"
              >
                {dayLabel(d.dayStart)}
              </text>
            ) : null,
          )}
          {/* area washes under the lines (10% — a wash, never a block) */}
          <path d={areaPath.in} className={IN_FILL} fillOpacity={0.1} />
          <path d={areaPath.out} className={OUT_FILL} fillOpacity={0.1} />
          {/* the lines: 2px, round joins */}
          <path d={linePath.in} className={IN_STROKE} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" fill="none" />
          <path d={linePath.out} className={OUT_STROKE} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" fill="none" />
          {/* crosshair + ringed markers at the snapped day */}
          {hovered ? (
            <g>
              <line
                x1={x(hover!)}
                x2={x(hover!)}
                y1={pad.top}
                y2={baseline}
                className="stroke-zinc-300 dark:stroke-zinc-600"
                strokeWidth={1}
              />
              <circle cx={x(hover!)} cy={y(hovered.inputTokens)} r={4} className={`${IN_FILL} stroke-white dark:stroke-zinc-900`} strokeWidth={2} />
              <circle cx={x(hover!)} cy={y(hovered.outputTokens)} r={4} className={`${OUT_FILL} stroke-white dark:stroke-zinc-900`} strokeWidth={2} />
            </g>
          ) : (
            <g>
              {/* resting end-markers with the surface ring */}
              <circle cx={x(days.length - 1)} cy={y(last.inputTokens)} r={4} className={`${IN_FILL} stroke-white dark:stroke-zinc-900`} strokeWidth={2} />
              <circle cx={x(days.length - 1)} cy={y(last.outputTokens)} r={4} className={`${OUT_FILL} stroke-white dark:stroke-zinc-900`} strokeWidth={2} />
              {endsApart ? (
                <g className="fill-zinc-500 text-[9px] tabular-nums dark:fill-zinc-400">
                  <text x={x(days.length - 1) + 8} y={y(last.inputTokens) + 3}>
                    {formatTokens(last.inputTokens)}
                  </text>
                  <text x={x(days.length - 1) + 8} y={y(last.outputTokens) + 3}>
                    {formatTokens(last.outputTokens)}
                  </text>
                </g>
              ) : null}
            </g>
          )}
        </svg>
      </div>
      <details className="mt-1">
        <summary className="dim cursor-pointer text-xs">data table</summary>
        <table className="mt-1.5 w-full text-left text-xs">
          <thead>
            <tr className="dim">
              <th className="py-0.5 font-normal">Day</th>
              <th className="py-0.5 text-right font-normal">Input</th>
              <th className="py-0.5 text-right font-normal">Output</th>
              <th className="py-0.5 text-right font-normal">Total</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d) => (
              <tr key={d.dayStart}>
                <td className="py-0.5">{dayLabel(d.dayStart)}</td>
                <td className="py-0.5 text-right tabular-nums">{d.inputTokens.toLocaleString()}</td>
                <td className="py-0.5 text-right tabular-nums">{d.outputTokens.toLocaleString()}</td>
                <td className="py-0.5 text-right tabular-nums">{(d.inputTokens + d.outputTokens).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

// ---------- models & estimated spend ---------------------------------------------

interface SpendRow {
  readonly key: string;
  readonly label: string;
  readonly runs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** null = no list price known for this model. */
  readonly cost: number | null;
}

const toSpendRow = (m: TokenUsageModel): SpendRow => ({
  key: m.model ?? '(default)',
  label: m.model ?? 'default model',
  runs: m.runs,
  inputTokens: m.inputTokens,
  outputTokens: m.outputTokens,
  cost: estimateUsd(m.model, m.inputTokens, m.outputTokens),
});

/** Rows past the cap fold into one line so a noisy window can't stretch the card. */
const foldRest = (rest: readonly SpendRow[]): SpendRow => ({
  key: '(other)',
  label: `${rest.length} more models`,
  runs: rest.reduce((acc, r) => acc + r.runs, 0),
  inputTokens: rest.reduce((acc, r) => acc + r.inputTokens, 0),
  outputTokens: rest.reduce((acc, r) => acc + r.outputTokens, 0),
  cost: rest.some((r) => r.cost !== null) ? rest.reduce((acc, r) => acc + (r.cost ?? 0), 0) : null,
});

/**
 * Most-used models with estimated spend (list prices from model-pricing.ts).
 * Unknown models show tokens with cost "—" and flip the total to "≥" — the
 * estimate never pretends to be complete.
 */
function ModelSpendCard({ models }: { models: ReadonlyArray<TokenUsageModel> }): JSX.Element {
  const all = models.map(toSpendRow);
  const rows = all.length <= 8 ? all : [...all.slice(0, 7), foldRest(all.slice(7))];
  const totalTokens = all.reduce((acc, r) => acc + r.inputTokens + r.outputTokens, 0);
  const totalRuns = all.reduce((acc, r) => acc + r.runs, 0);
  const totalIn = all.reduce((acc, r) => acc + r.inputTokens, 0);
  const totalOut = all.reduce((acc, r) => acc + r.outputTokens, 0);
  const knownCost = all.reduce((acc, r) => acc + (r.cost ?? 0), 0);
  const partial = all.some((r) => r.cost === null && r.inputTokens + r.outputTokens > 0);

  return (
    <figure className="card flex h-full flex-col">
      <figcaption className="flex items-baseline text-[13px] font-medium">
        Models — estimated spend
        <span className="dim ml-auto text-[11px] font-normal">share of token burn</span>
      </figcaption>
      <ul className="mt-1 divide-y divide-zinc-100 dark:divide-zinc-800/60">
        {rows.map((r) => {
          const share = ((r.inputTokens + r.outputTokens) / Math.max(1, totalTokens)) * 100;
          return (
            <li key={r.key} className="py-2.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate text-[13px] font-medium" title={r.label}>
                  {r.label}
                </span>
                <span className="shrink-0 text-sm font-semibold">
                  {r.cost === null ? <span className="dim font-normal">no list price</span> : formatUsd(r.cost)}
                </span>
              </div>
              <div className="mt-1.5 flex items-center gap-2">
                {/* share-of-burn meter — the track is a lighter step of the same
                    hue, so the bar reads as one meter, not bar-on-gray */}
                <span className="block h-1.5 flex-1 overflow-hidden rounded-full bg-[#2a78d6]/15 dark:bg-[#3987e5]/20" aria-hidden>
                  <span
                    className="block h-full rounded-full bg-[#2a78d6] dark:bg-[#3987e5]"
                    style={{ width: `${Math.max(1, share)}%` }}
                  />
                </span>
                <span className="dim w-9 shrink-0 text-right text-[11px] tabular-nums">{share.toFixed(0)}%</span>
              </div>
              <p className="dim mt-1 text-[11px]">
                {r.runs} run{r.runs === 1 ? '' : 's'} · {formatTokens(r.inputTokens)} in · {formatTokens(r.outputTokens)} out
              </p>
            </li>
          );
        })}
      </ul>
      <div className="mt-auto border-t border-zinc-200 pt-2 dark:border-zinc-800">
        <div className="flex items-baseline justify-between gap-3 text-xs">
          <span className="dim">
            {totalRuns} run{totalRuns === 1 ? '' : 's'} · {formatTokens(totalIn)} in · {formatTokens(totalOut)} out
          </span>
          <span className="font-semibold">{knownCost > 0 ? `${partial ? '≥ ' : ''}${formatUsd(knownCost)}` : '—'}</span>
        </div>
        <p className="dim mt-1.5 text-[11px]">
          Estimated from provider list prices; ignores prompt caching (cache reads/writes aren&apos;t tracked), so
          actual spend may differ.{partial ? ' Models without a known list price are excluded from the total.' : ''}
        </p>
      </div>
    </figure>
  );
}
