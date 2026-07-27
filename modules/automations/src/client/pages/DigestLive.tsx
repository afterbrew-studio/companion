import { useEffect, useState } from 'react';
import type { RunRecord } from '@companion/module-operate/contract';
import type { Block } from '@companion/module-operate/client';
import { Eyebrow, Page, Spinner, timeAgo } from '@moxxy-ai/companion-sdk/ui';
import type { ReportRecord } from '@companion/module-workspace/contract';
import { useDigestLive } from '../hooks/useDigestLive.js';

/**
 * A digest as an agent writes it: the loader view behind "Generate digest" /
 * "Watch live" — staged progress plus the agent's activity as it streams, then
 * a hand-off to the Daily Digest page the moment the report lands. The raw
 * transcript still lives at #/runs/:id for auditing.
 */
export function DigestLivePage({ repo }: { repo: string }): JSX.Element {
  const { run, blocks, phase, report } = useDigestLive(repo);

  // Celebrate briefly, then take the reader to the digest itself.
  useEffect(() => {
    if (phase !== 'done') return;
    const t = window.setTimeout(() => {
      window.location.hash = '#/digest';
    }, 2200);
    return () => window.clearTimeout(t);
  }, [phase]);

  return (
    <Page className="anim-in">
      <header>
        <Eyebrow>Daily digest</Eyebrow>
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
          <h1 className="min-w-0 flex-1 text-xl leading-snug font-semibold">Reviewing {repo}</h1>
          {run ? (
            <a className="btn-ghost shrink-0" href={`#/runs/${run.id}`} title="Open the full agent transcript">
              Full run
            </a>
          ) : null}
        </div>
      </header>

      <div className="mt-4">
        {phase === 'done' ? (
          <DoneStage repo={repo} report={report} />
        ) : phase === 'failed' ? (
          <FailedStage run={run} />
        ) : (
          <WorkingStage repo={repo} run={run} blocks={blocks} starting={phase === 'starting'} />
        )}
      </div>

      <p className="dim mt-4 text-xs">
        <a className="linkish" href="#/digest">
          ← Back to Daily Digest
        </a>
      </p>
    </Page>
  );
}

// ---------- working (agent reviewing) --------------------------------------------

const STEPS = [
  { label: 'Waking an agent', desc: 'Placing the run inside a fresh clone of the repo' },
  { label: 'Exploring the repository', desc: 'Git history, tracker facts, and the code itself' },
  { label: 'Writing the digest', desc: 'Judging what matters and where the project is heading' },
] as const;

const HINTS = [
  'Collecting what shipped, failed, and arrived…',
  'Skimming the git log…',
  'Weighing what deserves attention first…',
  'Reading between the commits…',
] as const;

function WorkingStage({
  repo,
  run,
  blocks,
  starting,
}: {
  repo: string;
  run: RunRecord | null;
  blocks: Block[];
  starting: boolean;
}): JSX.Element {
  const activity = recentActivity(blocks);
  // No granular phase data, so infer loosely: exploring once the run executes,
  // writing once the agent's own prose (not a tool echo) grows past a blurb.
  const last = blocks[blocks.length - 1];
  const writing = last?.kind === 'assistant' && last.text.trim().length > 120;
  const active = starting ? 0 : writing ? 2 : 1;

  return (
    <section className="anim-in flex flex-col gap-6">
      <div className="relative overflow-hidden rounded-2xl border border-accent-500/40 bg-gradient-to-b from-accent-500/10 to-transparent p-8 text-center">
        <div className="ppv-orb mx-auto flex size-16 items-center justify-center rounded-2xl bg-accent-500/15 text-accent-600 dark:text-accent-400">
          <DigestIcon />
        </div>
        <h2 className="mt-4 text-lg font-semibold">Writing your digest</h2>
        <p className="dim mx-auto mt-1 max-w-md text-[13px]">
          An agent is reviewing {repo} — what shipped, what failed, what matters now. The digest opens here the moment
          it lands{run ? <> · started {timeAgo(run.createdAt)}</> : null}.
        </p>
        <div className="ppv-shimmer mx-auto mt-5 h-1 w-56 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800" />
      </div>

      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        {/* Left: the high-level stepper. */}
        <div className="rounded-xl border border-zinc-200 dark:border-zinc-800">
          <Eyebrow className="border-b border-zinc-200 px-3.5 py-2 dark:border-zinc-800">Progress</Eyebrow>
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
          <Eyebrow className="border-b border-zinc-200 px-3.5 py-2 dark:border-zinc-800">Live activity</Eyebrow>
          <ol className="max-h-72 overflow-y-auto p-3.5">
            {activity.length === 0 ? (
              <li className="dim flex items-center gap-2 text-xs">
                <Spinner /> <CyclingHint />
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

/** While there is nothing real to show, rotate through what the agent is up to. */
function CyclingHint(): JSX.Element {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setI((v) => v + 1), 2600);
    return () => window.clearInterval(t);
  }, []);
  return <span className="anim-in" key={i % HINTS.length}>{HINTS[i % HINTS.length]}</span>;
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

// ---------- done / failed ---------------------------------------------------------

function DoneStage({ repo, report }: { repo: string; report: ReportRecord | null }): JSX.Element {
  return (
    <section className="anim-in rounded-2xl border border-emerald-500/40 bg-gradient-to-b from-emerald-500/10 to-transparent p-8 text-center">
      <div className="ppv-pop mx-auto flex size-16 items-center justify-center rounded-2xl bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
        <CheckIcon large />
      </div>
      <h2 className="mt-4 text-lg font-semibold">Digest ready</h2>
      <p className="dim mt-1 text-sm">{report?.title ?? `Daily digest — ${repo}`} · taking you to it…</p>
      <a className="btn mt-4 inline-flex" href="#/digest">
        Read the digest
      </a>
    </section>
  );
}

function FailedStage({ run }: { run: RunRecord | null }): JSX.Element {
  return (
    <section className="anim-in rounded-2xl border border-red-500/40 p-6">
      <div className="flex items-center gap-2.5">
        <span className="flex size-8 items-center justify-center rounded-lg bg-red-500/15 text-red-600 dark:text-red-400">
          <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden>
            <path d="m5 5 6 6M11 5l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </span>
        <h2 className="text-sm font-semibold">The agent couldn't finish</h2>
      </div>
      <p className="dim mt-2 text-sm">
        {run?.outcome ?? 'The run ended before the digest was written.'} Companion falls back to a plain fact-sheet
        digest — it lands on the Daily Digest page in a moment.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <a className="btn-ghost" href="#/digest">
          Back to Daily Digest
        </a>
        {run ? (
          <a className="btn-ghost" href={`#/runs/${run.id}`}>
            Open the full run
          </a>
        ) : null}
      </div>
    </section>
  );
}

// ---------- icons -----------------------------------------------------------------

function DigestIcon(): JSX.Element {
  // The Daily Digest nav glyph, enlarged for the hero orb.
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-7"
      aria-hidden
    >
      <path d="M4 5.5h13V17a3 3 0 0 0 3 3H7a3 3 0 0 1-3-3V5.5z" />
      <path d="M17 9h3.5v8a3 3 0 0 1-3 3" />
      <path d="M7.5 9.5h6M7.5 13h6M7.5 16.5h3.5" />
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
