import { useCallback, useEffect, useRef, useState } from 'react';
import type { RunRecord } from '@companion/contract';
import { api, onServerMessage } from '../lib/api.js';
import { emptyFold, foldEvent, foldMany, type Block, type FoldState } from '../transcript/fold.js';
import { DiffView } from '../components/DiffView.js';
import { Markdown } from '../components/Markdown.js';
import { Page, PageLoading, Spinner } from '../components/ui.js';

/**
 * The agentic "pull request in the making" view — a focused, animated take on a
 * fix/implement run: the agent builds the change live, then the proposed PR
 * (diff + summary) is previewed for one-click creation. The raw transcript
 * still lives at #/runs/:id for when you want the full trace.
 */
type Phase = 'loading' | 'building' | 'ready' | 'shipped' | 'failed';

export function PrPreview({ runId }: { runId: string }): JSX.Element {
  const [run, setRun] = useState<RunRecord | null>(null);
  const [fold, setFold] = useState<FoldState>(emptyFold);
  const [error, setError] = useState<string | null>(null);
  const foldRef = useRef(fold);
  foldRef.current = fold;

  const refresh = useCallback(async () => {
    try {
      const { run } = await api.getRun(runId);
      setRun(run);
      const segment = await api.history(runId, null, 300);
      setFold({ ...foldMany(emptyFold(), segment.events) });
    } catch (err) {
      setError(String(err));
    }
  }, [runId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    return onServerMessage((msg) => {
      if ('runId' in msg && msg.runId !== runId) return;
      if (msg.t === 'event') setFold({ ...foldEvent(foldRef.current, msg.event) });
      else if (msg.t === 'run.changed') setRun(msg.run);
    });
  }, [runId]);

  if (error && !run) {
    return (
      <Page>
        <div className="error-bar">{error}</div>
      </Page>
    );
  }
  if (!run) return <PageLoading label="Loading pull request…" />;

  const phase: Phase =
    run.status === 'completed'
      ? 'shipped'
      : run.status === 'review'
        ? 'ready'
        : run.status === 'running' || run.status === 'provisioning' || run.status === 'queued'
          ? 'building'
          : // failed / interrupted / stopped / abandoned — the run ended without a PR.
            'failed';

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-6">
      <header className="mb-5 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="dim text-[11px] font-medium tracking-widest uppercase">Pull request</div>
          <h1 className="mt-0.5 truncate text-xl leading-snug font-semibold">{run.title}</h1>
          {run.branch ? (
            <div className="dim mt-1 flex items-center gap-1.5 text-xs">
              <BranchIcon />
              <code className="font-mono">{run.branch}</code>
              {run.repo ? <span>· {run.repo}</span> : null}
            </div>
          ) : null}
        </div>
        <a className="btn-ghost shrink-0" href={`#/runs/${run.id}`} title="Open the full agent transcript">
          Full run
        </a>
      </header>

      {phase === 'building' ? (
        <BuildingStage run={run} blocks={fold.blocks} />
      ) : phase === 'ready' ? (
        <ReadyStage run={run} onChange={refresh} />
      ) : phase === 'shipped' ? (
        <ShippedStage run={run} />
      ) : (
        <FailedStage run={run} />
      )}
    </div>
  );
}

// ---------- building (agent working) --------------------------------------------

const STEPS = [
  { label: 'Understanding the issue', desc: 'Reading the issue and the relevant code' },
  { label: 'Writing the change', desc: 'Editing files on a fresh branch' },
  { label: 'Preparing the pull request', desc: 'Bundling the change into a PR' },
] as const;

function BuildingStage({ run, blocks }: { run: RunRecord; blocks: Block[] }): JSX.Element {
  // No granular phase data, so infer loosely: step 0 done once the agent starts
  // thinking, step 1 active while it works, step 2 lights up at review.
  const started = blocks.some((b) => b.kind !== 'user');
  const active = run.status === 'provisioning' ? 0 : started ? 1 : 0;
  const activity = recentActivity(blocks);

  return (
    <section className="anim-in">
      <div className="ppv-hero relative overflow-hidden rounded-2xl border border-accent-500/40 bg-gradient-to-b from-accent-500/10 to-transparent p-8 text-center">
        <div className="ppv-orb mx-auto flex size-16 items-center justify-center rounded-2xl bg-accent-500/15 text-accent-600 dark:text-accent-400">
          <SparkIcon />
        </div>
        <h2 className="mt-4 text-lg font-semibold">Building your pull request</h2>
        <p className="dim mx-auto mt-1 max-w-md text-[13px]">
          An agent is working on a branch. When it's done, its proposed change previews here for you to open as a PR.
        </p>
        <div className="ppv-shimmer mx-auto mt-5 h-1 w-56 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800" />
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        {/* Left: the high-level stepper, in a card matching the activity feed. */}
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800">
          <div className="dim border-b border-zinc-200 px-3.5 py-2 text-[11px] font-medium tracking-widest uppercase dark:border-zinc-800">
            Progress
          </div>
          <ol className="flex flex-col p-4">
            {STEPS.map((step, i) => {
              const state = i < active ? 'done' : i === active ? 'active' : 'pending';
              return (
                <li key={step.label} className="relative flex gap-3 pb-5 last:pb-0">
                  {i < STEPS.length - 1 ? (
                    <span
                      className={`absolute top-7 left-[13px] h-full w-0.5 -translate-x-1/2 ${
                        i < active ? 'bg-emerald-500/60' : 'bg-zinc-200 dark:bg-zinc-800'
                      }`}
                      aria-hidden
                    />
                  ) : null}
                  <span
                    className={`z-10 flex size-[26px] shrink-0 items-center justify-center rounded-full text-[11px] font-medium transition-colors ${
                      state === 'done'
                        ? 'bg-emerald-500 text-white'
                        : state === 'active'
                          ? 'bg-accent-500/15 text-accent-600 ring-4 ring-accent-500/10 dark:text-accent-400'
                          : 'bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500'
                    }`}
                  >
                    {state === 'done' ? <CheckIcon /> : state === 'active' ? <Spinner /> : i + 1}
                  </span>
                  <span className="min-w-0 pt-0.5">
                    <span className={`block text-[13px] ${state === 'pending' ? 'dim' : 'font-medium'}`}>
                      {step.label}
                    </span>
                    <span className={`block text-xs ${state === 'active' ? 'dim' : 'text-zinc-400 dark:text-zinc-600'}`}>
                      {step.desc}
                    </span>
                  </span>
                </li>
              );
            })}
          </ol>
        </div>

        {/* Right: the live activity timeline. */}
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800">
          <div className="dim border-b border-zinc-200 px-3.5 py-2 text-[11px] font-medium tracking-widest uppercase dark:border-zinc-800">
            Live activity
          </div>
          <ol className="max-h-72 overflow-y-auto p-3.5">
            {activity.length === 0 ? (
              <li className="dim flex items-center gap-2 text-xs">
                <Spinner /> Waiting for the agent to start…
              </li>
            ) : (
              activity.map((a, i) => (
                <li key={a.key} className="relative flex gap-2.5 pb-3 last:pb-0">
                  {i < activity.length - 1 ? (
                    <span className="absolute top-3 left-[3px] h-full w-px bg-zinc-200 dark:bg-zinc-800" aria-hidden />
                  ) : null}
                  <span
                    className={`z-10 mt-1 size-1.5 shrink-0 rounded-full ${
                      a.running ? 'ppv-live bg-accent-500' : 'bg-zinc-300 dark:bg-zinc-600'
                    }`}
                    aria-hidden
                  />
                  <span className={`min-w-0 flex-1 text-xs leading-relaxed ${a.running ? '' : 'dim'}`}>{a.text}</span>
                </li>
              ))
            )}
          </ol>
        </div>
      </div>
    </section>
  );
}

interface ActivityLine {
  key: string;
  text: string;
  running: boolean;
}

/** The most recent meaningful agent steps, newest first, for the live timeline. */
function recentActivity(blocks: Block[], limit = 8): ActivityLine[] {
  const out: ActivityLine[] = [];
  for (let i = blocks.length - 1; i >= 0 && out.length < limit; i--) {
    const b = blocks[i]!;
    if (b.kind === 'tool') {
      out.push({
        key: b.key,
        text: `${b.status === 'running' ? 'Running' : 'Ran'} ${b.name}${b.detail ? ` — ${b.detail}` : ''}`,
        running: b.status === 'running' || b.status === 'pending',
      });
    } else if ((b.kind === 'assistant' || b.kind === 'reasoning') && b.text.trim()) {
      out.push({ key: b.key, text: firstLine(b.text), running: b.streaming });
    }
  }
  return out;
}
function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

// ---------- ready (diff preview + create PR) ------------------------------------

function ReadyStage({ run, onChange }: { run: RunRecord; onChange: () => Promise<void> }): JSX.Element {
  const [diff, setDiff] = useState<string | null>(null);
  const [busy, setBusy] = useState<'create' | 'discard' | 'refine' | null>(null);
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .runDiff(run.id)
      .then((r) => alive && setDiff(r.diff))
      .catch((err) => alive && setError(String(err)));
    return () => {
      alive = false;
    };
  }, [run.id]);

  const create = async (): Promise<void> => {
    setBusy('create');
    setError(null);
    try {
      const { prUrl } = await api.approvePr(run.id);
      await onChange();
      window.open(prUrl, '_blank');
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  };

  const discard = async (): Promise<void> => {
    if (!confirm('Discard this pull request and its branch? The work is lost.')) return;
    setBusy('discard');
    try {
      await api.discardRun(run.id);
      await onChange();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  };

  const refine = async (): Promise<void> => {
    const text = prompt.trim();
    if (!text) return;
    setBusy('refine');
    setError(null);
    try {
      await api.prompt(run.id, text);
      setPrompt('');
      await onChange();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  };

  const stats = diff ? diffStat(diff) : null;

  return (
    <section className="anim-in flex flex-col gap-4">
      <div className="rounded-2xl border border-accent-500/50 bg-gradient-to-b from-accent-500/5 to-transparent p-5">
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
            <CheckIcon />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">Ready to open</h2>
            <p className="dim text-xs">
              The agent finished on <code className="font-mono">{run.branch}</code>
              {stats ? ` · ${stats.files} file${stats.files === 1 ? '' : 's'} changed` : ''}
            </p>
          </div>
          <button className="btn" disabled={busy !== null || diff === null} onClick={() => void create()}>
            {busy === 'create' ? 'Opening…' : 'Create pull request'}
          </button>
          <button className="btn-danger-ghost" disabled={busy !== null} onClick={() => void discard()}>
            {busy === 'discard' ? 'Discarding…' : 'Discard'}
          </button>
        </div>
        {run.outcome ? (
          <div className="mt-3 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
            <div className="dim mb-1 text-[11px] font-medium tracking-widest uppercase">Summary</div>
            <Markdown text={run.outcome} />
          </div>
        ) : null}
      </div>

      <div>
        <div className="dim mb-1.5 text-[11px] font-medium tracking-widest uppercase">Proposed change</div>
        {diff === null ? (
          <div className="dim flex items-center gap-2 py-6 text-sm">
            <Spinner /> Loading the diff…
          </div>
        ) : diff.trim() ? (
          <DiffView diff={diff} />
        ) : (
          <div className="banner-warn">The agent produced no changes.</div>
        )}
      </div>

      <div className="rounded-xl border border-zinc-300 p-2 focus-within:border-zinc-500 dark:border-zinc-700 dark:focus-within:border-zinc-400">
        <div className="dim px-1 pt-0.5 text-xs">Not quite right? Ask the agent to refine — it keeps the same branch.</div>
        <div className="mt-1 flex items-end gap-2">
          <textarea
            className="max-h-32 min-h-9 flex-1 resize-none border-none bg-transparent px-1.5 py-1 text-[13px] outline-none placeholder:text-zinc-400"
            placeholder="e.g. also add a test for the edge case"
            value={prompt}
            disabled={busy !== null}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void refine();
              }
            }}
          />
          <button className="btn-ghost" disabled={busy !== null || !prompt.trim()} onClick={() => void refine()}>
            {busy === 'refine' ? 'Sending…' : 'Refine'}
          </button>
        </div>
      </div>

      {error ? <div className="error-bar">{error}</div> : null}
    </section>
  );
}

function diffStat(diff: string): { files: number } {
  return { files: (diff.match(/^diff --git /gm) ?? []).length };
}

// ---------- shipped / failed ----------------------------------------------------

function ShippedStage({ run }: { run: RunRecord }): JSX.Element {
  return (
    <section className="anim-in rounded-2xl border border-emerald-500/40 bg-gradient-to-b from-emerald-500/10 to-transparent p-8 text-center">
      <div className="ppv-pop mx-auto flex size-16 items-center justify-center rounded-2xl bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
        <CheckIcon large />
      </div>
      <h2 className="mt-4 text-lg font-semibold">Pull request opened</h2>
      {run.prUrl ? (
        <p className="mt-2 text-sm">
          <a className="linkish" href={run.prUrl} target="_blank" rel="noreferrer">
            {run.prUrl}
          </a>
        </p>
      ) : (
        <p className="dim mt-2 text-sm">The run completed.</p>
      )}
    </section>
  );
}

function FailedStage({ run }: { run: RunRecord }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState(false);
  const cancelled =
    run.status === 'stopped' ||
    run.status === 'abandoned' ||
    /abort|cancel/i.test(run.outcome ?? '');

  const discard = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.discardRun(run.id);
      setGone(true);
    } catch {
      // leave the branch; the full run view can retry
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className={`anim-in rounded-2xl border p-6 ${cancelled ? 'border-zinc-300 dark:border-zinc-700' : 'border-red-500/40'}`}
    >
      <div className="flex items-center gap-2.5">
        <span
          className={`flex size-8 items-center justify-center rounded-lg ${
            cancelled
              ? 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'
              : 'bg-red-500/15 text-red-600 dark:text-red-400'
          }`}
        >
          <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden>
            <path d="m5 5 6 6M11 5l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </span>
        <h2 className="text-sm font-semibold">{cancelled ? 'Fix cancelled' : "The agent couldn't finish"}</h2>
      </div>
      <p className="dim mt-2 text-sm">
        {cancelled
          ? gone
            ? 'The branch and its worktree were discarded.'
            : 'The run was stopped before a pull request was ready. Its branch may hold partial work.'
          : (run.outcome ?? 'The run ended without producing a pull request.')}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <a className="btn-ghost" href={`#/runs/${run.id}`}>
          Open the full run
        </a>
        {run.branch && !gone ? (
          <button className="btn-danger-ghost" disabled={busy} onClick={() => void discard()}>
            {busy ? 'Discarding…' : 'Discard branch'}
          </button>
        ) : null}
      </div>
    </section>
  );
}

// ---------- icons ---------------------------------------------------------------

function SparkIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" className="size-7" aria-hidden>
      <path d="M12 3l1.8 5L19 9.8 14 12l-2 5-2-5-5-2.2L10 8l2-5z" fill="currentColor" fillOpacity="0.9" />
    </svg>
  );
}
function CheckIcon({ large }: { large?: boolean } = {}): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={large ? 'size-7' : 'size-3.5'} aria-hidden>
      <path d="m3.5 8.5 3 3 6-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function BranchIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="size-3.5" aria-hidden>
      <circle cx="4" cy="4" r="1.6" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="4" cy="12" r="1.6" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="12" cy="5" r="1.6" stroke="currentColor" strokeWidth="1.3" />
      <path d="M4 5.6v4.8M5.6 4H9a2 2 0 0 1 2 2v.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
