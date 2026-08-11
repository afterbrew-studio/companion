import { useMemo, useState } from 'react';
import { EmptyState, RowsSkeleton, Spinner, timeAgo } from '@moxxy/companion-sdk/ui';
import type {
  PlaygroundProductionEvaluationCase,
  PlaygroundProductionEvaluationRun,
  PlaygroundProductionEvaluationSnapshot,
} from '../../contract/index.js';
import { playgroundApi } from '../api.js';
import { ProductionEvaluationCard } from './ProductionEvaluationCard.js';

/** Guided release gate over immutable fixtures and exact production adapters. */
export function ProductionEvaluationSuite({
  snapshot,
  loading,
  refresh,
  reportError,
  canRun,
}: {
  readonly snapshot: PlaygroundProductionEvaluationSnapshot | null;
  readonly loading: boolean;
  readonly refresh: () => Promise<void>;
  readonly reportError: (message: string | null) => void;
  readonly canRun: boolean;
}): React.JSX.Element {
  const [startingSuite, setStartingSuite] = useState(false);
  const [cancellingSuite, setCancellingSuite] = useState(false);
  const [startingIds, setStartingIds] = useState<ReadonlySet<string>>(new Set());
  const cases = snapshot?.cases ?? [];
  const activeSuite = snapshot?.suites.find((suite) => suite.status === 'running') ?? null;
  const latestSuite = snapshot?.suites[0] ?? null;
  const activeByCase = useMemo(
    () => new Map((snapshot?.active ?? []).map((active) => [active.caseId, active])),
    [snapshot],
  );
  const activeSuiteCase = activeSuite?.currentCaseId
    ? (activeByCase.get(activeSuite.currentCaseId) ?? null)
    : null;
  const latestByCase = useMemo(() => {
    const latest = new Map<string, PlaygroundProductionEvaluationRun>();
    for (const run of snapshot?.runs ?? []) if (!latest.has(run.caseId)) latest.set(run.caseId, run);
    return latest;
  }, [snapshot]);
  const gateByCase = useMemo(
    () => new Map((snapshot?.rolloutGate.cases ?? []).map((result) => [result.caseId, result])),
    [snapshot],
  );
  const busy = startingSuite || startingIds.size > 0 || activeByCase.size > 0 || activeSuite !== null;
  const plannedRuns = cases.reduce((total, record) => total + record.requiredPasses, 0);

  const runCase = async (record: PlaygroundProductionEvaluationCase): Promise<void> => {
    setStartingIds((current) => new Set(current).add(record.id));
    reportError(null);
    try {
      await playgroundApi.runProductionEvaluation(record.id);
    } catch (err) {
      reportError(errorText(err));
    } finally {
      setStartingIds((current) => {
        const next = new Set(current);
        next.delete(record.id);
        return next;
      });
      await refresh();
    }
  };

  const runSuite = async (): Promise<void> => {
    setStartingSuite(true);
    reportError(null);
    try {
      await playgroundApi.startProductionEvaluationSuite();
    } catch (err) {
      reportError(errorText(err));
    } finally {
      setStartingSuite(false);
      await refresh();
    }
  };

  const cancelCase = async (caseId: string): Promise<void> => {
    reportError(null);
    try {
      await playgroundApi.cancelProductionEvaluation(caseId);
    } catch (err) {
      reportError(errorText(err));
    } finally {
      await refresh();
    }
  };

  const cancelSuite = async (): Promise<void> => {
    if (!activeSuite) return;
    setCancellingSuite(true);
    reportError(null);
    try {
      await playgroundApi.cancelProductionEvaluationSuite(activeSuite.id);
    } catch (err) {
      reportError(errorText(err));
    } finally {
      setCancellingSuite(false);
      await refresh();
    }
  };

  return (
    <section className="mb-8" aria-labelledby="production-evaluation-title">
      <div className={`rounded-xl border p-4 ${gateTone(snapshot?.rolloutGate.status ?? 'incomplete')}`}>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="production-evaluation-title" className="text-base font-semibold">Production rollout gate</h2>
              <span className={gateBadge(snapshot?.rolloutGate.status ?? 'incomplete')}>
                {gateLabel(snapshot?.rolloutGate.status ?? 'incomplete')}
              </span>
            </div>
            <p className="dim mt-1 max-w-4xl text-xs leading-relaxed">
              These immutable fixtures execute the exact prompt builder, strict parser and production task model
              policy. A prompt, parser, fixture or model-setting change automatically makes an old pass stale.
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {activeSuite ? (
              <>
                <span className="flex items-center gap-1.5 text-xs tabular-nums" role="status">
                  <Spinner /> {activeSuite.completed}/{activeSuite.total} · {activeSuite.currentCaseName ?? 'Preparing next case'}
                  {activeSuiteCase ? <span className="dim">· {activeSuiteCase.phase}</span> : null}
                </span>
                <button
                  className="btn-danger-ghost"
                  disabled={!canRun || cancellingSuite}
                  onClick={() => void cancelSuite()}
                >
                  {cancellingSuite ? 'Cancelling…' : 'Cancel release gate'}
                </button>
              </>
            ) : (
              <button
                className="btn"
                disabled={!canRun || cases.length === 0 || busy}
                title={canRun ? undefined : 'Requires runs:read and runs:act'}
                onClick={() => void runSuite()}
              >
                {startingSuite ? 'Starting…' : `Run release gate (${plannedRuns} runs)`}
              </button>
            )}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-6" aria-label="Production evaluation health">
          <GateMetric label="Cases" value={snapshot?.rolloutGate.total ?? 0} />
          <GateMetric label="Current passes" value={snapshot?.rolloutGate.passed ?? 0} tone="green" />
          <GateMetric label="Hard blockers" value={snapshot?.rolloutGate.blockers ?? 0} tone="red" />
          <GateMetric label="Stale" value={snapshot?.rolloutGate.stale ?? 0} tone="amber" />
          <GateMetric label="Not run" value={snapshot?.rolloutGate.notRun ?? 0} />
          <GateMetric label="Needs repeat" value={snapshot?.rolloutGate.insufficient ?? 0} tone="amber" />
        </div>
        {activeSuite ? (
          <div className="mt-3">
            <div
              className="h-1.5 overflow-hidden rounded-full bg-white/70 dark:bg-zinc-900/70"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={activeSuite.total}
              aria-valuenow={activeSuite.completed}
            >
              <div
                className="h-full bg-blue-500 transition-[width] duration-300"
                style={{ width: `${activeSuite.total ? (activeSuite.completed / activeSuite.total) * 100 : 0}%` }}
              />
            </div>
            <p className="dim mt-2 text-[11px] tabular-nums" role="status">
              {formatTokens(activeSuite.budget.inputTokens + activeSuite.budget.outputTokens)} /{' '}
              {formatTokens(activeSuite.budget.maxTokens)} tokens
              {' · '}{formatEstimatedCost(activeSuite.budget.estimatedCostUsd, activeSuite.budget.costPartial)}
              {' · '}hard stop {new Date(activeSuite.budget.deadlineAt).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </p>
          </div>
        ) : null}
        {!activeSuite && latestSuite ? (
          <p
            className="dim mt-3 text-[11px]"
            role={latestSuite.status === 'failed' || latestSuite.status === 'interrupted' ? 'alert' : undefined}
          >
            Last suite {suiteStatusLabel(latestSuite.status)} {timeAgo(latestSuite.updatedAt)}
            {' · '}{latestSuite.completed}/{latestSuite.total} cases processed
            {' · '}{formatTokens(latestSuite.budget.inputTokens + latestSuite.budget.outputTokens)} tokens
            {latestSuite.error ? ` · ${latestSuite.error}` : ''}
          </p>
        ) : null}
      </div>

      {loading && snapshot === null ? <div className="mt-3"><RowsSkeleton rows={4} /></div> : null}
      {!loading && snapshot && cases.length === 0 ? (
        <div className="mt-3">
          <EmptyState
            title="No production adapters are enabled"
            hint="Enable an agent-backed module such as Code, Contribution Quality, Ideas or Product Refinement to load its exact prompt/parser regressions."
          />
        </div>
      ) : null}
      {cases.length > 0 ? (
        <div className="mt-3 flex flex-col gap-3">
          {cases.map((record) => {
            const gate = gateByCase.get(record.id);
            if (!gate) return null;
            const active = activeByCase.get(record.id) ?? null;
            return (
              <ProductionEvaluationCard
                key={record.id}
                record={record}
                latest={latestByCase.get(record.id) ?? null}
                gate={gate}
                active={active}
                disabled={!canRun || busy}
                onRun={() => void runCase(record)}
                onCancel={() => void (activeSuite ? cancelSuite() : cancelCase(record.id))}
              />
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return value.toLocaleString();
}

function formatEstimatedCost(value: number, partial: boolean): string {
  if (partial && value === 0) return 'cost incomplete';
  const suffix = partial ? '+' : '';
  return `estimated $${value.toFixed(value >= 10 ? 2 : 3)}${suffix}`;
}

function GateMetric({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: number;
  readonly tone?: 'green' | 'amber' | 'red';
}): React.JSX.Element {
  const colour = tone === 'green'
    ? 'text-emerald-600 dark:text-emerald-400'
    : tone === 'amber'
      ? 'text-amber-600 dark:text-amber-400'
      : tone === 'red'
        ? 'text-red-600 dark:text-red-400'
        : '';
  return (
    <div>
      <div className="dim text-[10px] font-medium tracking-widest uppercase">{label}</div>
      <div className={`mt-0.5 text-xl font-semibold tabular-nums ${colour}`}>{value}</div>
    </div>
  );
}

function gateTone(status: PlaygroundProductionEvaluationSnapshot['rolloutGate']['status']): string {
  if (status === 'ready') return 'border-emerald-500/40 bg-emerald-500/5';
  if (status === 'blocked') return 'border-red-500/40 bg-red-500/5';
  return 'border-amber-500/40 bg-amber-500/5';
}

function gateBadge(status: PlaygroundProductionEvaluationSnapshot['rolloutGate']['status']): string {
  if (status === 'ready') return 'badge-ok';
  if (status === 'blocked') return 'badge-danger';
  return 'badge-warn';
}

function gateLabel(status: PlaygroundProductionEvaluationSnapshot['rolloutGate']['status']): string {
  if (status === 'ready') return 'rollout evidence current';
  if (status === 'blocked') return 'rollout blocked';
  return 'evidence incomplete';
}

function suiteStatusLabel(
  status: PlaygroundProductionEvaluationSnapshot['suites'][number]['status'],
): string {
  if (status === 'completed') return 'finished';
  if (status === 'cancelled') return 'was cancelled';
  if (status === 'interrupted') return 'was interrupted by a restart';
  if (status === 'failed') return 'failed';
  return 'is running';
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
