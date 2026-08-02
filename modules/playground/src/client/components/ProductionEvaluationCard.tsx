import { Spinner, StatusDot, timeAgo } from '@moxxy/companion-sdk/ui';
import type {
  PlaygroundProductionActiveRun,
  PlaygroundProductionEvaluationCase,
  PlaygroundProductionEvaluationRun,
  PlaygroundRolloutCaseResult,
} from '../../contract/index.js';

/** One immutable production regression with exact parser/config evidence. */
export function ProductionEvaluationCard({
  record,
  latest,
  gate,
  active,
  disabled,
  onRun,
  onCancel,
}: {
  readonly record: PlaygroundProductionEvaluationCase;
  readonly latest: PlaygroundProductionEvaluationRun | null;
  readonly gate: PlaygroundRolloutCaseResult;
  readonly active: PlaygroundProductionActiveRun | null;
  readonly disabled: boolean;
  readonly onRun: () => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const failedChecks = latest?.checks.filter((check) => !check.passed) ?? [];
  const tone = gate.status === 'passed'
    ? 'green'
    : gate.status === 'error'
      ? 'red'
      : gate.status === 'not_run' || gate.status === 'stale'
        ? 'zinc'
        : 'amber';
  return (
    <article className={`card p-4 ${gate.safetyCritical && gate.status !== 'passed' ? 'border-red-500/50' : ''}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {active ? <Spinner /> : <StatusDot tone={tone} />}
            <h3 className="font-medium">{record.name}</h3>
            {record.safetyCritical ? <span className="badge-danger">hard gate</span> : <span className="chip">advisory</span>}
            <span className="chip">{record.moduleId}</span>
            <span className="chip">adapter v{record.adapterVersion}</span>
            <span className="chip">case rev {record.revision}</span>
            <span className="chip">prompt {record.promptFingerprint}</span>
          </div>
          <p className="dim mt-1 text-xs leading-relaxed">{record.description}</p>
          <div className="dim mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
            <span>{record.adapterLabel}</span>
            <span>production task {record.task}</span>
            <span>{assertionCount(record)} deterministic checks</span>
            <span>{gate.currentPasses}/{gate.requiredPasses} stable passes</span>
            {latest ? <span>last replay {timeAgo(latest.createdAt)}</span> : <span>never replayed</span>}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {active ? (
            <button className="btn-danger-ghost" onClick={onCancel}>
              Cancel {active.phase}
            </button>
          ) : (
            <button className="btn" disabled={disabled} onClick={onRun}>
              {latest ? 'Replay case' : 'Run case'}
            </button>
          )}
        </div>
      </div>

      <div className={`mt-3 rounded-lg border px-3 py-2.5 ${gateTone(gate.status)}`}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <strong>{statusLabel(gate.status)}</strong>
          <span className="dim">{gate.reason}</span>
          {latest?.runId ? <a className="linkish ml-auto" href={`#/runs/${latest.runId}`}>Transcript →</a> : null}
        </div>
        {latest ? (
          <div className="dim mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] tabular-nums">
            <span>{formatDuration(latest.durationMs)}</span>
            <span>{formatTokens(latest.inputTokens, latest.outputTokens)}</span>
            <span>{latest.configuration.actualModel ?? 'runtime default model'}</span>
            <span>{latest.configuration.actualHarness ?? 'unknown harness'}</span>
            <span>config {latest.configuration.fingerprint}</span>
          </div>
        ) : null}
        {failedChecks.length > 0 ? (
          <ul className="mt-2 space-y-1 text-xs">
            {failedChecks.map((check, index) => (
              <li key={`${check.kind}-${index}`}>• <span className="font-medium">{check.label}</span> — {check.detail}</li>
            ))}
          </ul>
        ) : null}
        {latest ? (
          <details className="mt-2">
            <summary className="dim cursor-pointer text-xs hover:underline">
              Parser result, all checks and answer snapshot
            </summary>
            <div className="mt-2 grid gap-3 xl:grid-cols-3">
              <ul className="space-y-1 text-xs">
                {latest.checks.map((check, index) => (
                  <li
                    key={`${check.kind}-${index}`}
                    className={check.passed ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}
                  >
                    {check.passed ? '✓' : '×'} {check.label} — <span className="dim">{check.detail}</span>
                  </li>
                ))}
              </ul>
              <pre className="code-inline max-h-64 overflow-auto text-[11px] leading-relaxed whitespace-pre-wrap">
                {formatParsed(latest.parsedOutput)}
              </pre>
              <pre className="code-inline max-h-64 overflow-auto text-[11px] leading-relaxed whitespace-pre-wrap">
                {latest.message ?? latest.error ?? 'No answer snapshot.'}
              </pre>
            </div>
          </details>
        ) : null}
      </div>
    </article>
  );
}

function assertionCount(record: PlaygroundProductionEvaluationCase): number {
  const expectation = record.expectation;
  return expectation.requiredPhrases.length
    + expectation.forbiddenPhrases.length
    + expectation.requiredJsonPaths.length
    + Object.keys(expectation.expectedJson).length
    + [expectation.maxDurationMs, expectation.maxInputTokens, expectation.maxOutputTokens]
      .filter((value) => value !== null).length
    + 2; // response + exact production parser
}

function statusLabel(status: PlaygroundRolloutCaseResult['status']): string {
  if (status === 'passed') return 'Current path passed';
  if (status === 'insufficient') return 'Stability replay required';
  if (status === 'not_run') return 'Not run';
  if (status === 'stale') return 'Replay required';
  if (status === 'cancelled') return 'Cancelled';
  if (status === 'error') return 'Run error';
  return 'Checks failed';
}

function gateTone(status: PlaygroundRolloutCaseResult['status']): string {
  if (status === 'passed') return 'border-emerald-500/30 bg-emerald-500/5';
  if (status === 'error') return 'border-red-500/30 bg-red-500/5';
  if (status === 'not_run' || status === 'stale') return 'border-zinc-300 bg-zinc-500/5 dark:border-zinc-700';
  return 'border-amber-500/30 bg-amber-500/5';
}

function formatParsed(value: unknown): string {
  if (value === null) return 'The production parser returned no normalized snapshot.';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatDuration(ms: number): string {
  return ms < 1_000
    ? `${ms} ms`
    : ms < 60_000
      ? `${(ms / 1_000).toFixed(1)} s`
      : `${(ms / 60_000).toFixed(1)} min`;
}

function formatTokens(input: number | null, output: number | null): string {
  return input === null || output === null ? 'tokens unavailable' : `${(input + output).toLocaleString()} tokens`;
}
