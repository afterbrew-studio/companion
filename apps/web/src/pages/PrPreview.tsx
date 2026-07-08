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
    run.status === 'failed' || run.status === 'interrupted'
      ? 'failed'
      : run.status === 'completed'
        ? 'shipped'
        : run.status === 'review'
          ? 'ready'
          : 'building';

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

const STEPS = ['Understanding the issue', 'Writing the change', 'Preparing the pull request'] as const;

function BuildingStage({ run, blocks }: { run: RunRecord; blocks: Block[] }): JSX.Element {
  // No granular phase data, so infer loosely: step 0 done once the agent starts
  // thinking, step 1 active while it works, step 2 lights up at review.
  const started = blocks.some((b) => b.kind !== 'user');
  const active = run.status === 'provisioning' ? 0 : started ? 1 : 0;
  const latest = latestActivity(blocks);

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

      <ol className="mt-5 flex flex-col gap-2.5">
        {STEPS.map((label, i) => {
          const state = i < active ? 'done' : i === active ? 'active' : 'pending';
          return (
            <li key={label} className="flex items-center gap-3">
              <span
                className={`flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] ${
                  state === 'done'
                    ? 'bg-emerald-500 text-white'
                    : state === 'active'
                      ? 'bg-accent-500/15 text-accent-600 dark:text-accent-400'
                      : 'bg-zinc-100 text-zinc-400 dark:bg-zinc-800'
                }`}
              >
                {state === 'done' ? <CheckIcon /> : state === 'active' ? <Spinner /> : i + 1}
              </span>
              <span className={`text-sm ${state === 'pending' ? 'dim' : 'font-medium'}`}>{label}</span>
            </li>
          );
        })}
      </ol>

      {latest ? (
        <div className="dim mt-5 flex items-center gap-2 rounded-lg border border-zinc-200 px-3 py-2 text-xs dark:border-zinc-800">
          <span className="ppv-live size-1.5 shrink-0 rounded-full bg-accent-500" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{latest}</span>
        </div>
      ) : null}
    </section>
  );
}

/** A short human line describing what the agent is doing right now. */
function latestActivity(blocks: Block[]): string | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]!;
    if (b.kind === 'tool') return `${b.status === 'running' ? 'Running' : 'Ran'} ${b.name}${b.detail ? ` — ${b.detail}` : ''}`;
    if (b.kind === 'assistant' && b.text.trim()) return firstLine(b.text);
    if (b.kind === 'reasoning' && b.text.trim()) return firstLine(b.text);
  }
  return null;
}
function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 140 ? `${line.slice(0, 140)}…` : line;
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
  return (
    <section className="anim-in rounded-2xl border border-red-500/40 p-6">
      <h2 className="text-sm font-semibold text-red-600 dark:text-red-400">The agent couldn't finish</h2>
      {run.outcome ? <p className="dim mt-2 text-sm">{run.outcome}</p> : null}
      <a className="btn-ghost mt-3 inline-block" href={`#/runs/${run.id}`}>
        Open the full run
      </a>
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
