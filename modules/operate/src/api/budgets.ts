import type { ModuleConfigAccessor } from '@moxxy/companion-core';
import { StatusError } from '@moxxy/companion-core/server';
import { log } from '@moxxy/companion-services';
import type { BudgetScopeStatus, BudgetStatus, SpendBreakdown, SpendEntry } from '../contract/index.js';
import { estimateUsd, formatUsd, type ModelPricing } from '../contract/model-pricing.js';

/** Where an operator-declared price for a model comes from; null = use the table. */
export type PriceResolver = (model: string | null) => ModelPricing | null;
import type { RunsStore, SpendDimension, UsageModelRow } from './runs-store.js';

/**
 * Raised when a run is refused for want of budget. Carries a 402 so the router
 * answers "payment required" rather than a generic failure: the caller did
 * nothing wrong and re-trying will not help until someone acts.
 */
export class BudgetExceededError extends StatusError {
  constructor(message: string) {
    // Extending StatusError is what makes the 402 real: the router reads the
    // code off `err instanceof StatusError`, so carrying a `status` field on a
    // plain Error looked right and answered 500.
    super(402, message);
    this.name = 'BudgetExceededError';
  }
}

/** First instant of the current calendar month, local time. */
export function monthStart(now = Date.now()): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

/**
 * Spend is recomputed per check rather than accumulated, so it cannot drift
 * from the runs table. This memo only stops a burst of run creations from
 * re-running the same aggregate; it is short enough that a ceiling is never
 * overshot by more than the work started inside one window.
 */
const SPEND_TTL_MS = 5_000;

interface PricedTotals {
  costUsd: number;
  unpricedTokens: number;
}

function priceRows(rows: readonly UsageModelRow[], price: PriceResolver): PricedTotals {
  let costUsd = 0;
  let unpricedTokens = 0;
  for (const row of rows) {
    const cost = estimateUsd(row.model, row.input, row.output, price(row.model));
    if (cost === null) unpricedTokens += row.input + row.output;
    else costUsd += cost;
  }
  return { costUsd, unpricedTokens };
}

function scopeStatus(limitUsd: number, spentUsd: number): BudgetScopeStatus {
  const active = limitUsd > 0;
  return {
    limitUsd,
    spentUsd,
    percent: active ? (spentUsd / limitUsd) * 100 : null,
    exceeded: active && spentUsd >= limitUsd,
  };
}

/**
 * The instance's spend control: a monthly ceiling for the whole instance and
 * one per profile, both off by default. `check` is the gate every run creation
 * passes; `status` is what the UI renders.
 *
 * Two properties this is built around:
 *
 * - **A ceiling counts everything, not what the viewer may see.** Reads go
 *   through `spendByModel`, not the visibility-scoped usage queries.
 * - **Unpriced models are reported, never silently ignored.** A model with no
 *   list price contributes 0 to the ceiling because guessing a price would be
 *   worse, so its tokens are surfaced separately and the operator can see the
 *   ceiling is looking at less than the whole bill.
 */
export class Budgets {
  private cached: { at: number; instance: PricedTotals } | null = null;
  private readonly perUser = new Map<string, { at: number; totals: PricedTotals }>();
  /** Alert percentages already announced this period, so one crossing notifies once. */
  private announced = new Set<string>();
  private announcedPeriod = 0;

  constructor(
    private readonly runs: RunsStore,
    private readonly moduleConfig: ModuleConfigAccessor,
    /** Raises the operator-facing alert; wired to ctx.notify by services.ts. */
    private readonly alert: (title: string, body: string) => void,
    /**
     * An operator's own model prices. The built-in table cannot know an
     * endpoint configured this morning, and a ceiling that silently never
     * triggers is worse than not offering one.
     */
    private readonly price: PriceResolver = () => null,
  ) {}

  // ---------- configuration (module config, read live) -----------------------------

  private limit(key: string): number {
    const value = this.moduleConfig.get(key);
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
  }

  private alertPercent(): number {
    const value = this.moduleConfig.get('budgetAlertPercent');
    return typeof value === 'number' && value > 0 && value <= 100 ? value : 80;
  }

  // ---------- spend ----------------------------------------------------------------

  private instanceSpend(): PricedTotals {
    const now = Date.now();
    if (this.cached && now - this.cached.at < SPEND_TTL_MS) return this.cached.instance;
    const instance = priceRows(this.runs.spendByModel(monthStart(now)), this.price);
    this.cached = { at: now, instance };
    return instance;
  }

  private userSpend(userId: string): PricedTotals {
    const now = Date.now();
    const hit = this.perUser.get(userId);
    if (hit && now - hit.at < SPEND_TTL_MS) return hit.totals;
    const totals = priceRows(this.runs.spendByModel(monthStart(now), userId), this.price);
    this.perUser.set(userId, { at: now, totals });
    return totals;
  }

  // ---------- the gate -------------------------------------------------------------

  /**
   * Refuse a run that would spend past a ceiling. Called at the top of run
   * creation, before any side effect, so a refusal leaves nothing behind.
   *
   * The check is "already at the ceiling", not "would this run exceed it":
   * a run's cost is unknowable before it executes, so the last run of a period
   * is allowed to overshoot. Ceilings are therefore a stop, not a guarantee,
   * and the docs say so.
   */
  check(userId: string | null): void {
    const instanceLimit = this.limit('monthlyBudgetUsd');
    const userLimit = this.limit('userMonthlyBudgetUsd');
    if (instanceLimit === 0 && userLimit === 0) return;

    if (instanceLimit > 0) {
      const spent = this.instanceSpend().costUsd;
      if (spent >= instanceLimit) {
        throw new BudgetExceededError(
          `this instance has spent ${formatUsd(spent)} of its ${formatUsd(instanceLimit)} monthly budget. ` +
            'An administrator can raise it under Settings, or it resets at the start of next month.',
        );
      }
      this.maybeAlert('instance', spent, instanceLimit, 'This instance');
    }

    if (userLimit > 0 && userId) {
      const spent = this.userSpend(userId).costUsd;
      if (spent >= userLimit) {
        throw new BudgetExceededError(
          `you have spent ${formatUsd(spent)} of your ${formatUsd(userLimit)} monthly budget. ` +
            'Ask an administrator to raise it, or it resets at the start of next month.',
        );
      }
      this.maybeAlert(`user:${userId}`, spent, userLimit, `${userId}`);
    }
  }

  /** Announce a threshold crossing once per scope per period. */
  private maybeAlert(scope: string, spent: number, limit: number, subject: string): void {
    const period = monthStart();
    if (period !== this.announcedPeriod) {
      this.announced = new Set();
      this.announcedPeriod = period;
    }
    const percent = this.alertPercent();
    if (spent < (limit * percent) / 100 || this.announced.has(scope)) return;
    this.announced.add(scope);
    const title = `${subject} has used ${Math.round((spent / limit) * 100)}% of the monthly agent budget`;
    const body = `${formatUsd(spent)} of ${formatUsd(limit)}. Runs are refused once the ceiling is reached.`;
    log.warn('agent budget threshold crossed', { scope, spent, limit });
    try {
      this.alert(title, body);
    } catch (err) {
      // An alert that cannot be delivered must never take the run down with it.
      log.warn('budget alert could not be raised', { err: String(err) });
    }
  }

  // ---------- reads ----------------------------------------------------------------

  status(userId: string | null): BudgetStatus {
    const instance = this.instanceSpend();
    const user = userId ? this.userSpend(userId) : { costUsd: 0, unpricedTokens: 0 };
    return {
      periodStart: monthStart(),
      instance: scopeStatus(this.limit('monthlyBudgetUsd'), instance.costUsd),
      user: scopeStatus(this.limit('userMonthlyBudgetUsd'), user.costUsd),
      alertPercent: this.alertPercent(),
      unpricedTokens: instance.unpricedTokens,
    };
  }

  /** Where this period's spend went, along all three attribution dimensions. */
  breakdown(): SpendBreakdown {
    const since = monthStart();
    return {
      periodStart: since,
      byUser: this.attribute('user', since, (key) => key ?? 'automation'),
      byTask: this.attribute('task', since, (key) => key ?? 'unattributed'),
      byRepo: this.attribute('repo', since, (key) => key ?? 'no repository'),
    };
  }

  private attribute(
    dimension: SpendDimension,
    since: number,
    label: (key: string | null) => string,
  ): SpendEntry[] {
    const buckets = new Map<string, { entry: SpendEntry; partial: boolean }>();
    for (const row of this.runs.spendByDimension(dimension, since)) {
      const key = row.key ?? '';
      const cost = estimateUsd(row.model, row.input, row.output, this.price(row.model));
      const existing = buckets.get(key)?.entry;
      const partial = (buckets.get(key)?.partial ?? false) || (cost === null && row.input + row.output > 0);
      buckets.set(key, {
        partial,
        entry: {
          key,
          label: label(row.key),
          runs: (existing?.runs ?? 0) + row.runs,
          inputTokens: (existing?.inputTokens ?? 0) + row.input,
          outputTokens: (existing?.outputTokens ?? 0) + row.output,
          costUsd: (existing?.costUsd ?? 0) + (cost ?? 0),
          partial,
        },
      });
    }
    return [...buckets.values()]
      .map((b) => ({ ...b.entry, partial: b.partial }))
      .sort((a, b) => b.costUsd - a.costUsd || b.outputTokens - a.outputTokens);
  }
}
