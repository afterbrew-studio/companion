import { useCallback, useEffect, useState } from 'react';
import type {
  ChecksSummary,
  CheckRunInfo,
  PipelineRecord,
  PipelineRunRecord,
  PrRecord,
  PrReviewResult,
  ReportRecord,
} from '@companion/contract';
import { api, onServerMessage } from '../lib/api.js';
import { useAuth } from '../lib/auth.js';
import { useWorkspace } from '../lib/workspace.js';
import { Markdown } from '../components/Markdown.js';
import { AgentActivity } from '../components/AgentActivity.js';
import { AccountPicker } from '../components/AccountPicker.js';
import { CommentsSection } from '../components/Comments.js';
import { ActionMenu, ChevronDown, Page, ChecksBadge, CopyText, GitHubUser, PageLoading, PrStateIcon, Spinner, pipelineStatusBadge, timeAgo, useConfirm } from '../components/ui.js';

export function PrDetail({ repo, number }: { repo: string; number: number }): JSX.Element {
  const { can } = useAuth();
  const { current } = useWorkspace();
  const [pr, setPr] = useState<PrRecord | null>(null);
  const [review, setReview] = useState<PrReviewResult | null>(null);
  const [pipelineRuns, setPipelineRuns] = useState<PipelineRunRecord[]>([]);
  const [ciAnalysis, setCiAnalysis] = useState<ReportRecord | null>(null);
  const [pipelines, setPipelines] = useState<PipelineRecord[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirmDanger, confirmElement } = useConfirm();
  const canAct = can('prs:act');

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const { pr, review, pipelineRuns, ciAnalysis } = await api.getPr(repo, number);
      setPr(pr);
      setReview(review);
      setPipelineRuns(pipelineRuns);
      setCiAnalysis(ciAnalysis);
      if (review && review.status !== 'failed') setAnalyzing(false);
    } catch (err) {
      setError(String(err));
    }
  }, [repo, number]);

  useEffect(() => {
    void refresh();
    if (current && can('pipelines:read')) {
      api
        .workspacePipelines(current.id)
        .then((r) => setPipelines(r.pipelines.filter((pl) => pl.type === 'pr')))
        .catch(() => undefined);
    }
    return onServerMessage((msg) => {
      if ((msg.t === 'prs.changed' || msg.t === 'pipelineRuns.changed') && msg.repo === repo) void refresh();
      if (msg.t === 'reports.changed') void refresh();
    });
  }, [refresh, current, can, repo]);

  const analyze = async (): Promise<void> => {
    setAnalyzing(true);
    setError(null);
    try {
      await api.analyzePr(repo, number);
    } catch (err) {
      setAnalyzing(false);
      setError(String(err));
    }
  };

  const act = (fn: () => Promise<unknown>) => async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!pr) return error ? <Page><div className="error-bar">{error}</div></Page> : <PageLoading />;

  return (
    <Page className="anim-in">
      <header>
        <div className="flex items-start justify-between gap-3">
          <h1 className="min-w-0 flex-1 text-xl leading-snug font-semibold">
            <CopyText value={`#${pr.number}`} className="dim mr-1.5 align-baseline font-normal">
              #{pr.number}
            </CopyText>
            {pr.title}
          </h1>
          <div className="flex shrink-0 items-center gap-2" role="toolbar" aria-label="Pull request actions">
            {canAct ? (
              <button className="btn" disabled={analyzing} onClick={() => void analyze()}>
                {analyzing ? (
                  <>
                    <Spinner /> Reviewing…
                  </>
                ) : review ? (
                  'Re-review'
                ) : (
                  'AI review'
                )}
              </button>
            ) : null}
            <a className="btn-ghost" href={pr.url} target="_blank" rel="noreferrer">
              GitHub ↗
            </a>
            {canAct && pr.state === 'open' ? (
              <ActionMenu
                label="More pull request actions"
                actions={[
                  {
                    label: 'Squash-merge…',
                    disabled: busy,
                    onSelect: () =>
                      void (async () => {
                        const ok = await confirmDanger({
                          title: `Merge PR #${pr.number}`,
                          message: `"${pr.title}" is squash-merged into ${pr.baseRef}. Merging cannot be undone from Companion.`,
                          confirmLabel: 'Squash-merge',
                        });
                        if (ok) await act(() => api.mergePr(repo, number, 'squash'))();
                      })(),
                  },
                  {
                    label: 'Close PR…',
                    danger: true,
                    disabled: busy,
                    onSelect: () =>
                      void (async () => {
                        const ok = await confirmDanger({
                          title: `Close PR #${pr.number}`,
                          message: 'The pull request is closed on GitHub without merging.',
                          confirmLabel: 'Close PR',
                        });
                        if (ok) await act(() => api.closePr(repo, number))();
                      })(),
                  },
                ]}
              />
            ) : null}
          </div>
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[13px]">
          <PrStateIcon state={pr.state} draft={pr.draft} decision={pr.reviewDecision} />
          <ChecksBadge checks={pr.checks} />
          <span className="dim flex min-w-0 flex-wrap items-center gap-x-1.5">
            <GitHubUser login={pr.author} className="text-zinc-700 dark:text-zinc-300" />
            <span aria-hidden>·</span>
            <CopyText value={pr.headRef} title={`Copy branch "${pr.headRef}"`} className="min-w-0">
              <code className="truncate text-xs">
                {pr.headRef} → {pr.baseRef}
              </code>
            </CopyText>
            <span aria-hidden>·</span>
            <span>opened {timeAgo(pr.createdAt)}</span>
            <span aria-hidden>·</span>
            <span>updated {timeAgo(pr.updatedAt)}</span>
          </span>
        </div>
      </header>
      {error ? <div className="error-bar">{error}</div> : null}
      {confirmElement}

      <article className="card mt-4 max-h-[420px] overflow-y-auto">
        {pr.body ? <Markdown text={pr.body} /> : <span className="dim text-sm">(no description)</span>}
      </article>

      <ChecksPanel repo={repo} number={number} canAct={canAct} ciAnalysis={ciAnalysis} />

      <PipelinesPanel
        repo={repo}
        number={number}
        prOpen={pr.state === 'open'}
        pipelines={pipelines}
        runs={pipelineRuns}
        canRun={can('pipelines:run')}
        onError={setError}
      />

      <AgentActivity repo={repo} issueNumber={number} />

      {analyzing && !review ? (
        <div className="banner-info anim-in">
          <Spinner /> Review agent is reading the diff and CI status…
        </div>
      ) : null}
      {review ? <ReviewCard review={review} canAct={canAct} onChange={refresh} /> : null}

      <CommentsSection
        load={() => api.prComments(repo, number)}
        post={canAct ? (body) => api.commentPr(repo, number, body) : undefined}
        canComment={canAct}
      />
    </Page>
  );
}

// ---------- CI checks -----------------------------------------------------------

function checkOutcome(run: CheckRunInfo): { label: string; cls: string; failed: boolean } {
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

function ChecksPanel({
  repo,
  number,
  canAct,
  ciAnalysis,
}: {
  repo: string;
  number: number;
  canAct: boolean;
  ciAnalysis: ReportRecord | null;
}): JSX.Element {
  const [checks, setChecks] = useState<ChecksSummary | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [open, setOpen] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [showAnalysis, setShowAnalysis] = useState(true);

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

  const sorted = checks ? [...checks.runs].sort((a, b) => Number(checkOutcome(b).failed) - Number(checkOutcome(a).failed)) : [];

  return (
    <section className="card mt-4" aria-label="CI pipelines">
      <div className="flex flex-wrap items-center gap-2.5">
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
          ) : (
            <>
              <ChecksBadge checks={checks} />
              <span className="dim">
                {checks.passed} passed · {checks.failed} failed · {checks.pending} running
              </span>
            </>
          )
        ) : null}
        <span className="flex-1" />
        {checks && checks.failed > 0 && canAct ? (
          <button className="btn" disabled={analyzing} onClick={() => void analyzeFailures()}>
            {analyzing ? (
              <>
                <Spinner /> Investigating…
              </>
            ) : (
              'Analyze failures with AI'
            )}
          </button>
        ) : null}
        {checks && checks.runs.length > 0 ? (
          <button className="linkish text-sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? 'hide' : `show ${checks.runs.length} checks`}
          </button>
        ) : null}
        <button className="btn-ghost" onClick={load} aria-label="Refresh CI status">
          Refresh
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
        <div className="anim-in mt-3 rounded-lg border border-accent-400/50 p-3 dark:border-accent-500/40">
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

// ---------- user pipelines -------------------------------------------------------

function PipelinesPanel({
  repo,
  number,
  prOpen,
  pipelines,
  runs,
  canRun,
  onError,
}: {
  repo: string;
  number: number;
  prOpen: boolean;
  pipelines: PipelineRecord[];
  runs: PipelineRunRecord[];
  canRun: boolean;
  onError: (e: string) => void;
}): JSX.Element | null {
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  if (pipelines.length === 0 && runs.length === 0) return null;

  const run = async (): Promise<void> => {
    if (!selected) return;
    setBusy(true);
    try {
      await api.runPipeline(repo, number, selected);
    } catch (err) {
      onError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const canStart = canRun && prOpen && pipelines.length > 0;

  return (
    <section className="card mt-4 p-0" aria-label="Pipelines">
      <div className="flex items-center gap-2 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
        <strong className="text-sm">Pipelines</strong>
        {runs.length > 0 ? (
          <span className="dim tabular-nums">
            {runs.length} run{runs.length === 1 ? '' : 's'}
          </span>
        ) : null}
      </div>

      {runs.length > 0 ? (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800/60">
          {runs.map((r) => (
            <li key={r.id} className="anim-in">
              <button
                className="flex w-full cursor-pointer items-center gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900"
                onClick={() => setExpanded((v) => (v === r.id ? null : r.id))}
                aria-expanded={expanded === r.id}
              >
                {r.status === 'running' ? <Spinner /> : null}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium">{r.pipelineName}</span>
                  <span className="dim mt-0.5 block text-xs">
                    {r.trigger === 'pr-opened' ? 'auto-run on PR open' : 'manual run'} · {timeAgo(r.createdAt)}
                  </span>
                </span>
                <span className={pipelineStatusBadge(r.status)}>{r.status}</span>
                <ChevronDown open={expanded === r.id} className="dim size-4 shrink-0" />
              </button>
              {expanded === r.id ? (
                <ol
                  className="flex flex-col gap-2 border-t border-zinc-100 bg-zinc-50/60 px-4 py-3 dark:border-zinc-800/60 dark:bg-zinc-900/40"
                  aria-label="Step results"
                >
                  {r.steps.map((s, i) => (
                    <li key={i} className="flex items-start gap-2 text-[13px]">
                      <span className={pipelineStatusBadge(s.status)}>{s.status}</span>
                      <div className="min-w-0 flex-1">
                        <div className="font-medium">{s.name}</div>
                        {s.summary ? <div className="dim">{s.summary}</div> : null}
                        {s.detail ? (
                          <details className="mt-0.5">
                            <summary className="dim cursor-pointer text-xs">detail</summary>
                            <div className="mt-1 max-h-48 overflow-y-auto">
                              <Markdown text={s.detail} />
                            </div>
                          </details>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ol>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="dim px-4 py-6 text-center text-[13px]">
          {canStart ? 'No pipeline has run against this PR yet — pick one below to start.' : 'No pipeline has run against this PR yet.'}
        </p>
      )}

      {canStart ? (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <select
            className="input py-1.5"
            aria-label="Pipeline to run"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
          >
            <option value="">Choose a pipeline…</option>
            {pipelines.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button className="btn" disabled={!selected || busy} onClick={() => void run()}>
            {busy ? (
              <>
                <Spinner /> Starting…
              </>
            ) : (
              'Run pipeline'
            )}
          </button>
        </div>
      ) : null}
    </section>
  );
}

// ---------- AI review ---------------------------------------------------------------

function ReviewCard({
  review,
  canAct,
  onChange,
}: {
  review: PrReviewResult;
  canAct: boolean;
  onChange: () => Promise<void>;
}): JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [actAs, setActAs] = useState('');
  const v = review.verdict;
  const riskClass = v?.risk === 'high' ? 'badge-danger' : v?.risk === 'medium' ? 'badge-warn' : 'badge-ok';

  return (
    <div
      className={`anim-in mt-4 rounded-xl border p-4 ${
        review.status === 'applied' ? 'border-emerald-500/60' : 'border-amber-500/60'
      }`}
    >
      <div className="mb-2 flex items-center gap-2.5">
        <strong>AI review</strong>
        <span className={review.status === 'applied' ? 'badge-ok' : 'badge-warn'}>{review.status}</span>
        <a className="dim hover:underline" href={`#/runs/${review.runId}`}>
          view run →
        </a>
      </div>
      {v ? (
        <>
          <p className="text-sm">{v.summary}</p>
          <div className="my-2 flex flex-wrap gap-1.5">
            <span className={riskClass}>risk: {v.risk}</span>
            <span className="badge-accent">{v.recommendation.replace('_', ' ')}</span>
          </div>
          {v.findings.length > 0 ? (
            <ul className="mt-1.5 list-disc pl-5 text-[13px]">
              {v.findings.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          ) : null}
          <blockquote className="my-2.5 border-l-2 border-zinc-300 py-1 pl-3 dark:border-zinc-600">
            <div className="dim text-[13px]">review to post</div>
            <Markdown text={v.reviewBody} />
          </blockquote>
          {review.status === 'pending' && canAct ? (
            <div className="mt-3.5 flex flex-wrap items-center gap-2.5 border-t border-zinc-200 pt-3.5 dark:border-zinc-800">
              <span className="flex-1" />
              <AccountPicker value={actAs} onChange={setActAs} />
              <button
                className="btn order-last"
                onClick={() =>
                  void api
                    .applyPrReview(review.id, actAs || undefined)
                    .then(onChange)
                    .catch((e) => setError(String(e)))
                }
              >
                Post review to GitHub
              </button>
              <button
                className="btn-ghost"
                onClick={() =>
                  void api
                    .dismissPrReview(review.id)
                    .then(onChange)
                    .catch((e) => setError(String(e)))
                }
              >
                Dismiss
              </button>
            </div>
          ) : null}
        </>
      ) : (
        <p className="error-bar">{review.error ?? 'no verdict'}</p>
      )}
      {error ? <div className="error-bar">{error}</div> : null}
    </div>
  );
}
