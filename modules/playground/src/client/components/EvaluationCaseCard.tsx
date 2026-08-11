import { Spinner, StatusDot, timeAgo } from '@moxxy/companion-sdk/ui';
import type { PlaygroundEvaluationCaseRecord, PlaygroundEvaluationRun } from '../../contract/index.js';

export function EvaluationCaseCard({
  record,
  latest,
  running,
  disabled,
  onRun,
  onEdit,
  onDelete,
}: {
  readonly record: PlaygroundEvaluationCaseRecord;
  readonly latest: PlaygroundEvaluationRun | null;
  readonly running: boolean;
  readonly disabled: boolean;
  readonly onRun: () => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
}): React.JSX.Element {
  const failedChecks = latest?.checks.filter((check) => !check.passed) ?? [];
  const tone = latest?.status === 'passed' ? 'green' : latest?.status === 'error' ? 'red' : latest ? 'amber' : 'zinc';
  return (
    <article className={`card p-4 ${record.safetyCritical && latest?.status !== 'passed' ? 'border-red-500/50' : ''}`}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {running ? <Spinner /> : <StatusDot tone={tone} />}
            <h2 className="font-medium">{record.name}</h2>
            {record.safetyCritical ? <span className="badge-danger">rollout blocker</span> : null}
            <span className="chip">rev {record.revision}</span>
            {record.repo ? <span className="chip">{record.repo}</span> : <span className="chip">private scratch</span>}
            {record.tags.map((tag) => <span key={tag} className="chip">{tag}</span>)}
          </div>
          {record.description ? <p className="dim mt-1 text-xs">{record.description}</p> : null}
          <div className="dim mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
            <span>{expectationSummary(record)}</span>
            <span>timeout {formatDuration(record.timeoutMs)}</span>
            {record.skill ? <span>skill {record.skill}</span> : null}
            {latest ? <span>last run {timeAgo(latest.createdAt)}</span> : <span>never run</span>}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button className="btn" disabled={running || disabled} onClick={onRun}>
            {running ? 'Running…' : latest ? 'Run again' : 'Run case'}
          </button>
          <button className="btn-ghost" disabled={running} onClick={onEdit}>Edit</button>
          <button className="btn-danger-ghost" disabled={running} onClick={onDelete}>Delete</button>
        </div>
      </div>

      {latest ? (
        <div className={`mt-3 rounded-lg border px-3 py-2.5 ${resultTone(latest.status)}`}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <strong>
              {latest.status === 'passed'
                ? 'Passed'
                : latest.status === 'error'
                  ? 'Run error'
                  : `${failedChecks.length} check${failedChecks.length === 1 ? '' : 's'} failed`}
            </strong>
            <span className="dim">prompt v{latest.promptVersion} · case rev {latest.caseRevision}</span>
            <span className="dim tabular-nums">
              {formatDuration(latest.durationMs)} · {formatTokens(latest.inputTokens, latest.outputTokens)}
            </span>
            {latest.model ? <span className="dim">{latest.model}</span> : null}
            {latest.runId ? <a className="linkish ml-auto" href={`#/runs/${latest.runId}`}>Transcript →</a> : null}
          </div>
          {latest.error ? <p className="mt-2 text-xs text-red-600 dark:text-red-400">{latest.error}</p> : null}
          {failedChecks.length > 0 ? (
            <ul className="mt-2 space-y-1 text-xs">
              {failedChecks.map((check, index) => (
                <li key={`${check.kind}-${index}`}>• <span className="font-medium">{check.label}</span> — {check.detail}</li>
              ))}
            </ul>
          ) : null}
          <details className="mt-2">
            <summary className="dim cursor-pointer text-xs hover:underline">All checks and answer snapshot</summary>
            <div className="mt-2 grid gap-3 lg:grid-cols-2">
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
                {latest.message ?? 'No answer snapshot.'}
              </pre>
            </div>
          </details>
        </div>
      ) : null}
    </article>
  );
}

function resultTone(status: PlaygroundEvaluationRun['status']): string {
  if (status === 'passed') return 'border-emerald-500/30 bg-emerald-500/5';
  if (status === 'error') return 'border-red-500/30 bg-red-500/5';
  return 'border-amber-500/30 bg-amber-500/5';
}

function expectationSummary(record: PlaygroundEvaluationCaseRecord): string {
  const expectation = record.expectation;
  const assertions = expectation.requiredPhrases.length
    + expectation.forbiddenPhrases.length
    + expectation.requiredJsonPaths.length
    + Object.keys(expectation.expectedJson).length;
  const ceilings = [expectation.maxDurationMs, expectation.maxInputTokens, expectation.maxOutputTokens]
    .filter((value) => value !== null).length;
  return `${expectation.responseFormat} · ${assertions} assertion${assertions === 1 ? '' : 's'}${
    ceilings ? ` · ${ceilings} resource gate${ceilings === 1 ? '' : 's'}` : ''
  }`;
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
