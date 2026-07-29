import { useCallback, useState } from 'react';
import { EmptyState, ErrorBar, ListCard, Page, PageHeader, PageLoading, Section, formatTokens } from '@moxxy/companion-ui';
import { useLive } from '@moxxy/companion-core/client';
import type { SpendBreakdown, SpendEntry } from '../../contract/index.js';
import { formatUsd } from '../../contract/model-pricing.js';
import { operateApi as api } from '../api.js';

/**
 * Where this month's agent spend went, along the three dimensions a run carries:
 * who triggered it, what kind of work it served, and which repository it touched.
 *
 * Priced from the same table the budget gate uses, so the number here is the
 * number that will refuse a run. Every total is an estimate from provider list
 * prices, and a bucket that used an unpriced model is marked as a floor rather
 * than being quietly under-reported.
 */
export function SpendPage(): JSX.Element {
  const [breakdown, setBreakdown] = useState<SpendBreakdown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async (): Promise<void> => {
    try {
      setBreakdown(await api.spendBreakdown());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useLive(refresh, (msg) => msg.t === 'run.changed' || msg.t === 'runs.changed');

  if (breakdown === null) {
    return error === null ? (
      <PageLoading label="Loading spend…" />
    ) : (
      <Page>
        <PageHeader title="Spend" />
        <ErrorBar error={error} />
      </Page>
    );
  }

  const empty =
    breakdown.byUser.length === 0 && breakdown.byTask.length === 0 && breakdown.byRepo.length === 0;

  return (
    <Page>
      <PageHeader
        title="Spend"
        subtitle={`Estimated agent cost since ${new Date(breakdown.periodStart).toLocaleDateString()}, the period the monthly budget is measured over`}
      />
      <ErrorBar error={error} />
      {empty ? (
        <EmptyState
          title="No agent runs this month"
          hint="Attribution appears once runs start. Ceilings are set per module under Modules → Operate."
        />
      ) : (
        <>
          <Table title="By person" caption="Automation runs with no triggering profile are grouped as 'automation'." entries={breakdown.byUser} />
          <Table title="By work" caption="The registered task a run served. Runs predating attribution show as 'unattributed'." entries={breakdown.byTask} />
          <Table title="By repository" entries={breakdown.byRepo} />
        </>
      )}
    </Page>
  );
}

function Table({
  title,
  caption,
  entries,
}: {
  title: string;
  caption?: string;
  entries: readonly SpendEntry[];
}): JSX.Element | null {
  if (entries.length === 0) return null;
  const total = entries.reduce((acc, e) => acc + e.costUsd, 0);
  const partial = entries.some((e) => e.partial);

  return (
    <Section title={title}>
      <ListCard subtle ariaLabel={title}>
        {entries.map((entry) => (
          <div key={entry.key} className="flex items-baseline justify-between gap-3 px-4 py-2.5 text-sm">
            <span className="truncate font-medium">{entry.label}</span>
            <span className="dim shrink-0 text-xs">
              {entry.runs} run{entry.runs === 1 ? '' : 's'} · {formatTokens(entry.inputTokens + entry.outputTokens)}{' '}
              tokens
            </span>
            <span className="shrink-0 tabular-nums">
              {entry.partial ? '≥ ' : ''}
              {formatUsd(entry.costUsd)}
            </span>
          </div>
        ))}
        <div className="flex items-baseline justify-between gap-3 border-t border-zinc-200 px-4 py-2.5 text-sm dark:border-zinc-800">
          <span className="font-semibold">Total</span>
          <span className="font-semibold tabular-nums">
            {partial ? '≥ ' : ''}
            {formatUsd(total)}
          </span>
        </div>
      </ListCard>
      {caption ? <p className="dim mt-1.5 text-xs">{caption}</p> : null}
      {partial ? (
        <p className="dim mt-1 text-xs">
          Rows marked ≥ include tokens from models with no list price; their real cost is higher than shown.
        </p>
      ) : null}
    </Section>
  );
}
