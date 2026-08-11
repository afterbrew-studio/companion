import { useCallback, useState } from 'react';
import { formatTokens } from '@moxxy/companion-ui';
import { useLive } from '@moxxy/companion-core/client';
import type { BudgetScopeStatus, BudgetStatus } from '../../contract/index.js';
import { formatUsd } from '../../contract/model-pricing.js';
import { operateApi as api } from '../api.js';

/**
 * Where this month's spend stands against the configured ceilings. Renders
 * nothing when no ceiling is set, which is the default: an instance that has
 * not opted into a budget should not be shown an empty meter.
 *
 * Its own dashboard widget rather than a section of the token-burn card, so it
 * survives that card's "no usage in the last 14 days" early return. A month
 * whose spend landed early is exactly when a ceiling matters most.
 */
export function BudgetBar(): React.JSX.Element | null {
  const [budget, setBudget] = useState<BudgetStatus | null>(null);
  const refresh = useCallback(async (): Promise<void> => {
    // A budget the viewer may not read is not an error worth a banner; the
    // meter simply stays absent.
    try {
      setBudget(await api.budget());
    } catch {
      setBudget(null);
    }
  }, []);
  useLive(refresh, (msg) => msg.t === 'run.changed' || msg.t === 'runs.changed');

  if (!budget) return null;
  const scopes = [
    { label: 'Instance', scope: budget.instance },
    { label: 'You', scope: budget.user },
  ].filter((s) => s.scope.limitUsd > 0);
  if (scopes.length === 0) return null;

  return (
    <section className="mt-6" aria-labelledby="budget-heading">
      <h2 id="budget-heading" className="mb-2 text-sm font-semibold">
        Monthly budget <span className="dim font-normal">· since {new Date(budget.periodStart).toLocaleDateString()}</span>
      </h2>
      <div className="card flex flex-col gap-3 p-4">
        {scopes.map(({ label, scope }) => (
          <Meter key={label} label={label} scope={scope} alertPercent={budget.alertPercent} />
        ))}
        {budget.unpricedTokens > 0 ? (
          <p className="dim text-xs">
            {formatTokens(budget.unpricedTokens)} tokens this month rode models with no list price, so they are not
            counted against the ceiling. Real spend is higher than shown.
          </p>
        ) : null}
      </div>
    </section>
  );
}

function Meter({
  label,
  scope,
  alertPercent,
}: {
  label: string;
  scope: BudgetScopeStatus;
  alertPercent: number;
}): React.JSX.Element {
  const percent = scope.percent ?? 0;
  // Three states, because "80% of budget" and "budget spent" are different news.
  const tone = scope.exceeded
    ? 'bg-red-500 dark:bg-red-400'
    : percent >= alertPercent
      ? 'bg-amber-500 dark:bg-amber-400'
      : 'bg-emerald-500 dark:bg-emerald-400';

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="font-medium">{label}</span>
        <span className={scope.exceeded ? 'font-semibold text-red-600 dark:text-red-400' : 'dim'}>
          {formatUsd(scope.spentUsd)} of {formatUsd(scope.limitUsd)}
          {scope.exceeded ? ' · runs refused' : ` · ${Math.round(percent)}%`}
        </span>
      </div>
      <div
        className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
        role="meter"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${label} monthly agent budget`}
      >
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, percent)}%` }} />
      </div>
    </div>
  );
}
