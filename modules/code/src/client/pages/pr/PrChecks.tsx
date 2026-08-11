import { useCallback, useEffect, useState } from 'react';
import type { ReportRecord } from '@companion/module-workspace/contract';
import { AiActionMenu, ChevronDown, Markdown, Spinner, timeAgo, type MenuAction } from '@moxxy/companion-sdk/ui';
import type { CheckRunInfo, ChecksSummary } from '../../../contract/index.js';
import { codeApi as api } from '../../api.js';
import { ChecksIcon } from '../../widgets.js';

/**
 * GitHub CI for the PR's head commit — the folded check-run summary, the
 * per-run breakdown, and the AI failure post-mortem when one exists. Fetches
 * the full summary itself (lazy, refreshable); the compact snapshot on the PR
 * row is only good enough for the sidebar badge.
 */
export function PrChecks({
  repo,
  number,
  canAct,
  ciAnalysis,
  onFixChecks,
}: {
  repo: string;
  number: number;
  canAct: boolean;
  ciAnalysis: ReportRecord | null;
  /** Starts the repair agent; null when the PR can't take one (closed, no rights). */
  onFixChecks: (() => void) | null;
}): React.JSX.Element {
  const [checks, setChecks] = useState<ChecksSummary | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [open, setOpen] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [showAnalysis, setShowAnalysis] = useState(true);
  const [rerunning, setRerunning] = useState(false);

  const load = useCallback((): void => {
    setState('loading');
    api
      .prChecks(repo, number)
      .then((r) => {
        setChecks(r.checks);
        setState('ready');
        if (r.checks.failed > 0) setOpen(true);
      })
      .catch(() => setState('error'));
  }, [repo, number]);

  useEffect(load, [load]);

  // A fresh report arriving over reports.changed means the analysis is done.
  useEffect(() => {
    if (ciAnalysis) setAnalyzing(false);
  }, [ciAnalysis?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const analyzeFailures = async (): Promise<void> => {
    setAnalyzing(true);
    try {
      await api.analyzeFailedChecks(repo, number);
    } catch {
      setAnalyzing(false);
    }
  };

  const sorted = checks
    ? [...checks.runs].sort((a, b) => Number(checkOutcome(b).failed) - Number(checkOutcome(a).failed))
    : [];

  const expandable = Boolean(checks && checks.runs.length > 0);
  const rerun = async (scope: 'failed' | 'all'): Promise<void> => {
    setRerunning(true);
    try {
      await api.rerunChecks(repo, number, scope);
      // GitHub takes a moment to report the restarted runs as queued; refetching
      // instantly would just redraw the old conclusions.
      setTimeout(load, 2_000);
    } finally {
      setRerunning(false);
    }
  };

  const aiActions: MenuAction[] =
    canAct && checks && checks.failed > 0
      ? [
          {
            label: rerunning ? 'Re-running…' : 'Re-run failed jobs',
            disabled: rerunning,
            onSelect: () => void rerun('failed'),
          },
          {
            label: 'Re-run all jobs',
            disabled: rerunning,
            onSelect: () => void rerun('all'),
          },
          {
            label: analyzing ? 'Investigating…' : 'Analyze failures with AI',
            disabled: analyzing,
            onSelect: () => void analyzeFailures(),
          },
          ...(onFixChecks ? [{ label: 'Fix failing checks', onSelect: onFixChecks }] : []),
        ]
      : [];

  return (
    <section className="card" aria-label="CI pipelines">
      <div className="flex items-center gap-2">
        {/* The whole title row is the expand/collapse control. */}
        <button
          type="button"
          className={`flex min-w-0 flex-1 flex-wrap items-center gap-2.5 text-left ${expandable ? 'cursor-pointer' : 'cursor-default'}`}
          onClick={() => expandable && setOpen((v) => !v)}
          aria-expanded={open}
          disabled={!expandable}
        >
          <strong className="text-sm">CI pipelines</strong>
          {state === 'loading' ? (
            <span className="dim flex items-center gap-1.5">
              <Spinner /> checking…
            </span>
          ) : null}
          {state === 'error' ? <span className="badge-danger">status unavailable</span> : null}
          {state === 'ready' && checks ? (
            checks.state === 'none' ? (
              <span className="dim">no pipelines reported for this commit</span>
            ) : checks.state === 'unknown' ? (
              <span className="badge-warn" title="Grant the GitHub token 'Checks: read' and 'Commit statuses: read'">
                checks unavailable — token can&apos;t read CI
              </span>
            ) : (
              <>
                <ChecksIcon checks={checks} />
                <span className="dim">
                  {checks.passed} passed · {checks.failed} failed · {checks.pending} running
                </span>
              </>
            )
          ) : null}
          {expandable ? <ChevronDown open={open} className="dim size-4 shrink-0" /> : null}
        </button>
        {aiActions.length > 0 ? <AiActionMenu label="AI actions for failing checks" busy={analyzing} actions={aiActions} /> : null}
        <button className="btn-ghost w-9 shrink-0 justify-center px-0" onClick={load} aria-label="Refresh CI status" title="Refresh">
          <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden>
            <path
              d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 1.5v3h-3"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      {open && checks ? (
        <ul className="mt-2.5 divide-y divide-zinc-200 dark:divide-zinc-800">
          {sorted.map((run, i) => {
            const o = checkOutcome(run);
            const d = duration(run);
            return (
              <li key={`${run.name}-${i}`} className="anim-in flex items-center gap-2.5 py-1.5 text-[13px]">
                <span className={o.cls}>{o.label}</span>
                <span className="min-w-0 flex-1 truncate">{run.name}</span>
                {d ? <span className="dim text-xs tabular-nums">{d}</span> : null}
                {run.detailsUrl ? (
                  <a className="linkish" href={run.detailsUrl} target="_blank" rel="noreferrer">
                    logs ↗
                  </a>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {analyzing && !ciAnalysis ? (
        <div className="banner-info anim-in mt-3">
          <Spinner /> Agent is reproducing the failing pipelines locally — the report lands here.
        </div>
      ) : null}
      {ciAnalysis ? (
        <div className="card anim-in mt-3 border-accent-400/50 dark:border-accent-500/40">
          <div className="flex items-center gap-2">
            <strong className="text-[13px]">AI failure analysis</strong>
            <span className="dim text-xs">{timeAgo(ciAnalysis.createdAt)}</span>
            <span className="flex-1" />
            <button className="linkish text-sm" onClick={() => setShowAnalysis((v) => !v)}>
              {showAnalysis ? 'hide' : 'show'}
            </button>
          </div>
          {showAnalysis ? (
            <div className="mt-1.5 max-h-96 overflow-y-auto">
              <Markdown text={ciAnalysis.body} />
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function checkOutcome(run: CheckRunInfo): { label: string; cls: string; failed: boolean } {
  if (run.status !== 'completed') return { label: 'running', cls: 'badge-warn', failed: false };
  const ok = run.conclusion === 'success' || run.conclusion === 'neutral' || run.conclusion === 'skipped';
  return ok
    ? { label: run.conclusion ?? 'ok', cls: 'badge-ok', failed: false }
    : { label: run.conclusion ?? 'failed', cls: 'badge-danger', failed: true };
}

function duration(run: CheckRunInfo): string | null {
  if (!run.startedAt || !run.completedAt) return null;
  const s = Math.max(0, Math.round((run.completedAt - run.startedAt) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
