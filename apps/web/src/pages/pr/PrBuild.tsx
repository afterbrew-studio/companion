import { useCallback, useState } from 'react';
import type { RunRecord } from '@companion/contract';
import { api } from '../../lib/api.js';
import type { Block } from '../../transcript/fold.js';
import { Markdown } from '../../components/Markdown.js';
import { Page, PageLoading, Spinner, timeAgo } from '../../components/ui.js';
import { usePrBuild, type BuildPhase, type UsePrBuild } from './usePrBuild.js';
import { PrChanges } from './PrChanges.js';

/**
 * A pull request as an agent builds it: the same view shell as {@link PrView},
 * but sourced from a run. It fills in as the work lands — animated while the
 * agent works, the proposed change once it's ready, then a link to the opened
 * PR. The raw transcript still lives at #/runs/:id.
 */
export function PrBuild({ runId }: { runId: string }): JSX.Element {
  const build = usePrBuild(runId);
  const fetchDiff = useCallback(() => api.runDiff(runId).then((r) => r.diff), [runId]);

  if (build.error && !build.run) {
    return (
      <Page>
        <div className="error-bar">{build.error}</div>
      </Page>
    );
  }
  if (!build.run) return <PageLoading label="Loading pull request…" />;
  const run = build.run;

  return (
    <Page className="anim-in">
      <header>
        <div className="dim text-[11px] font-medium tracking-widest uppercase">Pull request</div>
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
          <h1 className="min-w-0 flex-1 text-xl leading-snug font-semibold">{run.title}</h1>
          <a className="btn-ghost shrink-0" href={`#/runs/${run.id}`} title="Open the full agent transcript">
            Full run
          </a>
        </div>
      </header>

      <div className="mt-4 grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_15rem]">
        <div className="flex min-w-0 flex-col gap-4">
          {build.phase === 'building' ? (
            <BuildingStage run={run} blocks={build.blocks} />
          ) : build.phase === 'ready' ? (
            <ReadyStage build={build} run={run} fetchDiff={fetchDiff} />
          ) : build.phase === 'shipped' ? (
            <ShippedStage run={run} />
          ) : (
            <FailedStage build={build} run={run} />
          )}
          {build.error ? <div className="error-bar">{build.error}</div> : null}
        </div>

        <BuildSidebar run={run} phase={build.phase} />
      </div>
    </Page>
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
    <section className="anim-in flex flex-col gap-6">
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

      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        {/* Left: the high-level stepper. */}
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
                          ? 'bg-zinc-100 text-accent-600 ring-4 ring-accent-500/15 dark:bg-zinc-800 dark:text-accent-400'
                          : 'bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500'
                    }`}
                  >
                    {state === 'done' ? <CheckIcon /> : state === 'active' ? <Spinner /> : i + 1}
                  </span>
                  <span className="min-w-0 pt-0.5">
                    <span className={`block text-[13px] ${state === 'pending' ? 'dim' : 'font-medium'}`}>{step.label}</span>
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

function ReadyStage({
  build,
  run,
  fetchDiff,
}: {
  build: UsePrBuild;
  run: RunRecord;
  fetchDiff: () => Promise<string>;
}): JSX.Element {
  const [prompt, setPrompt] = useState('');

  const create = async (): Promise<void> => {
    // Reserve the tab in the click gesture so it isn't popup-blocked after the
    // await; we stay on this page and the PR opens beside it.
    const tab = window.open('', '_blank');
    const url = await build.createPr();
    if (url) {
      if (tab) tab.location.href = url;
      else window.open(url, '_blank');
    } else {
      tab?.close();
    }
  };

  const discard = async (): Promise<void> => {
    if (!confirm('Discard this pull request and its branch? The work is lost.')) return;
    await build.discard();
  };

  const refine = async (): Promise<void> => {
    await build.refine(prompt);
    setPrompt('');
  };

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
            </p>
          </div>
          <button className="btn" disabled={build.busy !== null} onClick={() => void create()}>
            {build.busy === 'create' ? 'Opening…' : 'Create pull request'}
          </button>
          <button className="btn-danger-ghost" disabled={build.busy !== null} onClick={() => void discard()}>
            {build.busy === 'discard' ? 'Discarding…' : 'Discard'}
          </button>
        </div>
        {run.outcome ? (
          <div className="mt-3 rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
            <div className="dim mb-1 text-[11px] font-medium tracking-widest uppercase">Summary</div>
            <Markdown text={run.outcome} />
          </div>
        ) : null}
      </div>

      <PrChanges fetchDiff={fetchDiff} />

      <div className="rounded-xl border border-zinc-300 p-2 focus-within:border-zinc-500 dark:border-zinc-700 dark:focus-within:border-zinc-400">
        <div className="dim px-1 pt-0.5 text-xs">Not quite right? Ask the agent to refine — it keeps the same branch.</div>
        <div className="mt-1 flex items-end gap-2">
          <textarea
            className="max-h-32 min-h-9 flex-1 resize-none border-none bg-transparent px-1.5 py-1 text-[13px] outline-none placeholder:text-zinc-400"
            placeholder="e.g. also add a test for the edge case"
            value={prompt}
            disabled={build.busy !== null}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void refine();
              }
            }}
          />
          <button className="btn-ghost" disabled={build.busy !== null || !prompt.trim()} onClick={() => void refine()}>
            {build.busy === 'refine' ? 'Sending…' : 'Refine'}
          </button>
        </div>
      </div>
    </section>
  );
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

function FailedStage({ build, run }: { build: UsePrBuild; run: RunRecord }): JSX.Element {
  const [gone, setGone] = useState(false);
  const cancelled =
    run.status === 'stopped' || run.status === 'abandoned' || /abort|cancel/i.test(run.outcome ?? '');

  const discard = async (): Promise<void> => {
    await build.discard();
    setGone(true);
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
          <button className="btn-danger-ghost" disabled={build.busy !== null} onClick={() => void discard()}>
            {build.busy === 'discard' ? 'Discarding…' : 'Discard branch'}
          </button>
        ) : null}
      </div>
    </section>
  );
}

// ---------- build metadata rail -------------------------------------------------

function BuildSidebar({ run, phase }: { run: RunRecord; phase: BuildPhase }): JSX.Element {
  const status =
    phase === 'building'
      ? { label: 'Building', cls: 'badge-warn' }
      : phase === 'ready'
        ? { label: 'Ready to open', cls: 'badge-accent' }
        : phase === 'shipped'
          ? { label: 'Opened', cls: 'badge-ok' }
          : { label: 'Ended', cls: 'badge' };

  return (
    <aside className="flex flex-col gap-4 text-[13px] lg:sticky lg:top-4" aria-label="Build details">
      <div className="card flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <span className="dim w-16 shrink-0 text-xs font-medium tracking-wide uppercase">Status</span>
          <span className={status.cls}>{status.label}</span>
        </div>
        {run.branch ? (
          <div className="min-w-0">
            <div className="dim mb-1 text-[11px] font-medium tracking-wide uppercase">Branch</div>
            <code className="block truncate font-mono text-xs" title={run.branch}>
              {run.branch}
            </code>
          </div>
        ) : null}
        {run.repo ? (
          <div className="min-w-0">
            <div className="dim mb-1 text-[11px] font-medium tracking-wide uppercase">Repository</div>
            <code className="block truncate font-mono text-xs" title={run.repo}>
              {run.repo}
            </code>
          </div>
        ) : null}
      </div>

      <div className="card flex flex-col gap-2 text-xs">
        <div className="flex justify-between gap-2">
          <span className="dim">Started</span>
          <span>{timeAgo(run.createdAt)}</span>
        </div>
        {run.model ? (
          <div className="flex justify-between gap-2">
            <span className="dim">Model</span>
            <span className="truncate" title={run.model}>
              {run.model}
            </span>
          </div>
        ) : null}
        <a className="linkish mt-1 text-xs" href={`#/runs/${run.id}`}>
          Open full run →
        </a>
      </div>
    </aside>
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
