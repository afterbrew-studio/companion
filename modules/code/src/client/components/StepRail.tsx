import { Markdown, Spinner, StatusGlyph } from '@moxxy/companion-sdk/ui';
import type { PipelineRunRecord, PipelineStepResult } from '../../contract/index.js';
import { StepRemedies } from './PrActions.js';
import { StepOutput } from './StepOutput.js';
import { useEffect, useState } from 'react';
import { codeApi as api } from '../api.js';

type Status = PipelineStepResult['status'];

/**
 * How each status reads. The word is the signal and the colour only reinforces
 * it, because "which of these two greys is the failed one" is not a question a
 * status display should ever ask.
 */
const STATE: Record<Status, { tone: 'ok' | 'warn' | 'danger' | 'muted'; word: string; node: string }> = {
  passed: { tone: 'ok', word: 'passed', node: 'border-emerald-500 bg-emerald-500' },
  failed: { tone: 'danger', word: 'failed', node: 'border-red-500 bg-red-500' },
  cancelled: { tone: 'muted', word: 'stopped', node: 'border-zinc-400 bg-zinc-400 dark:border-zinc-600 dark:bg-zinc-600' },
  error: { tone: 'warn', word: 'could not run', node: 'border-amber-500 bg-amber-500' },
  running: { tone: 'muted', word: 'running', node: 'border-sky-500 bg-sky-500' },
  awaiting: { tone: 'warn', word: 'needs your confirmation', node: 'border-amber-500 bg-amber-500' },
  pending: { tone: 'muted', word: 'waiting', node: 'border-zinc-300 dark:border-zinc-700' },
  skipped: { tone: 'muted', word: 'skipped', node: 'border-zinc-300 dark:border-zinc-700' },
};

function durationOf(s: PipelineStepResult): string | null {
  if (s.startedAt === null) return null;
  const end = s.finishedAt ?? Date.now();
  const secs = Math.max(0, Math.round((end - s.startedAt) / 1000));
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

/**
 * A pipeline run as a vertical rail: one node per step, connected, in order.
 *
 * A flat list could not answer the question people actually bring to a run,
 * which is "where is it now and what is left". The rail makes position obvious
 * without anyone reading a status word, and the connector above a node is
 * coloured by the step BEFORE it, so a broken run shows exactly where the
 * colour stops.
 */
export function StepRail({ run, repo, number }: { run: PipelineRunRecord; repo: string; number: number }): JSX.Element {
  const [, setClock] = useState(0);
  useEffect(() => {
    if (run.status !== 'running') return;
    const timer = setInterval(() => setClock((value) => value + 1), 1_000);
    return () => clearInterval(timer);
  }, [run.status]);

  return (
    <ol className="flex flex-col" aria-label={`${run.pipelineName} steps`}>
      {run.steps.map((s, i) => {
        const state = STATE[s.status];
        const prev = i > 0 ? run.steps[i - 1] : null;
        const duration = durationOf(s);
        return (
          <li key={i} className="flex gap-3">
            {/* rail */}
            <div className="flex w-4 shrink-0 flex-col items-center">
              <div
                className={`w-px flex-none ${i === 0 ? 'h-2 bg-transparent' : 'h-3'} ${
                  prev && prev.status === 'passed' ? 'bg-emerald-500/40' : 'bg-zinc-300 dark:bg-zinc-700'
                }`}
              />
              {s.status === 'running' ? (
                <span className="flex size-2.5 items-center justify-center">
                  <span className="size-2.5 animate-pulse rounded-full bg-sky-500" />
                </span>
              ) : (
                <span className={`size-2.5 rounded-full border ${state.node}`} />
              )}
              <div
                className={`w-px flex-1 ${i === run.steps.length - 1 ? 'bg-transparent' : ''} ${
                  s.status === 'passed' ? 'bg-emerald-500/40' : 'bg-zinc-300 dark:bg-zinc-700'
                }`}
              />
            </div>

            {/* step */}
            <div className="min-w-0 flex-1 pb-3">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className={`text-[13px] ${s.status === 'pending' ? 'dim' : 'font-medium'}`}>{s.name}</span>
                <StatusGlyph tone={state.tone} label={state.word} />
                <span className="dim text-xs">{state.word}</span>
                {s.status === 'running' ? <Spinner /> : null}
                {duration ? <span className="dim text-xs tabular-nums">· {duration}</span> : null}
              </div>

              {s.summary ? <p className="dim mt-0.5 text-xs">{s.summary}</p> : null}

              {(s.kind === 'executable' || s.kind === 'npm-bootstrap') && (s.status === 'running' || s.log?.text) ? (
                <StepOutput runId={run.id} stepIndex={i} initialLog={s.log} running={s.status === 'running'} />
              ) : null}
              {s.status === 'awaiting' ? <ApprovalPrompt runId={run.id} stepIndex={i} /> : null}

              {s.outputs && Object.keys(s.outputs).length > 0 ? (
                <div className="mt-1 flex flex-wrap gap-1">
                  {Object.entries(s.outputs).map(([k, v]) => (
                    <span key={k} className="badge normal-case font-mono text-[11px]" title={`${k} = ${v}`}>
                      {k}: {v.length > 24 ? `${v.slice(0, 24)}…` : v}
                    </span>
                  ))}
                </div>
              ) : null}

              {s.detail ? (
                <details className="mt-1">
                  <summary className="dim cursor-pointer text-xs">detail</summary>
                  <div className="mt-1 max-h-56 overflow-y-auto">
                    <Markdown text={s.detail} />
                  </div>
                </details>
              ) : null}

              {s.status !== 'passed' && s.remedies?.length ? (
                <StepRemedies remedies={s.remedies} repo={repo} number={number} />
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** The two answers a held step accepts. Declining halts the rest of the run. */
function ApprovalPrompt({ runId, stepIndex }: { runId: string; stepIndex: number }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answer = (approved: boolean): void => {
    setBusy(true);
    setError(null);
    void api
      .approvePipelineStep(runId, stepIndex, approved)
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      <button className="btn text-xs" disabled={busy} onClick={() => answer(true)}>
        Confirm
      </button>
      <button className="btn-ghost text-xs" disabled={busy} onClick={() => answer(false)}>
        Skip and stop
      </button>
      {error ? <span className="text-xs text-red-500">{error}</span> : null}
    </div>
  );
}
