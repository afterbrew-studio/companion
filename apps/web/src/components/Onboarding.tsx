import { useEffect, useState } from 'react';
import type { Permission } from '@companion/contract';
import { useAuth } from '../lib/auth.js';

/**
 * Onboarding: a short, animated, skippable tour. Two modes off one step list:
 *
 *  - `full` — the whole tour, shown once on first entry (and on replay).
 *  - `whatsnew` — only the steps a returning user hasn't seen yet, shown once
 *    when new steps appear (i.e. after a feature ships a new step).
 *
 * Extending it is one entry: append a `Step` to `STEPS` with a fresh `key`.
 * Existing users automatically get a "What's new" popup for just that step;
 * brand-new users get it inline in the full tour. Steps are role-aware (a step
 * whose `need` permission the user lacks is dropped), and the last step
 * deep-links to the most useful next action. Seen step keys are remembered in
 * localStorage, so the tracking survives new steps being added later.
 */

const SEEN_KEY = 'companion.onboarding.seen';

function seenKeys(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? 'null') as string[]);
  } catch {
    return new Set();
  }
}

/** True once the user has been through onboarding at least once. */
export function hasOnboarded(): boolean {
  return localStorage.getItem(SEEN_KEY) !== null;
}

export type OnboardingMode = 'full' | 'whatsnew';

export interface Step {
  readonly key: string;
  /** Hide this step unless the user holds the permission. */
  readonly need?: Permission;
  readonly title: string;
  readonly body: string;
  readonly chips?: ReadonlyArray<string>;
  readonly art: (playing: boolean) => JSX.Element;
}

const STEPS: readonly Step[] = [
  {
    key: 'welcome',
    title: 'Welcome to Companion',
    body: 'Your repositories, run by AI agents. Companion triages issues, reviews pull requests, drafts specs and docs, and turns ideas into merged PRs — with you in control at every step.',
    art: (playing) => <MascotArt playing={playing} />,
  },
  {
    key: 'connect',
    need: 'settings:manage',
    title: 'Connect GitHub, add repositories',
    body: 'Start by connecting a GitHub account and adding repositories to a workspace. Companion syncs issues and PRs and clones each repo so agents can work on it.',
    chips: ['Settings → GitHub', 'Repositories'],
    art: (playing) => <LinkArt playing={playing} />,
  },
  {
    key: 'plan',
    need: 'proposals:read',
    title: 'Plan: proposals, specs & docs',
    body: 'Describe a change in plain language — an agent assesses feasibility, then implements it into a PR. Specifications ground that work in how your code should behave; documentation is indexed so every agent knows your project.',
    chips: ['Proposals', 'Specifications', 'Documentation'],
    art: (playing) => <PlanArt playing={playing} />,
  },
  {
    key: 'code',
    need: 'prs:read',
    title: 'Code: issues, PRs & pipelines',
    body: 'Triage issues, review pull requests with CI context, and let agents fix failing checks or address review feedback right on the branch. Compose pipelines from typed steps to automate it all.',
    chips: ['Issues', 'Pull Requests', 'Pipelines'],
    art: (playing) => <CodeArt playing={playing} />,
  },
  {
    key: 'assistant',
    title: 'AI Help — your platform copilot',
    body: 'The sparkle in the top-right corner opens AI Help. Ask it anything about your workspace, or just tell it what to do — run a pipeline, find an issue, file a proposal — and it does it, scoped to your access.',
    chips: ['Top-right ✦'],
    art: (playing) => <SparkArt playing={playing} />,
  },
  {
    key: 'runners',
    need: 'runners:manage',
    title: 'Scale across machines',
    body: 'Agent work runs on this machine by default. Attach more machines as runners — shared across workspaces or delegated to specific ones — to run more agents in parallel.',
    chips: ['Runners'],
    art: (playing) => <RunnersArt playing={playing} />,
  },
];

/** The best first action for the role, shown as the finish CTA. */
function finishCta(can: (p: Permission) => boolean): { label: string; href: string } {
  if (can('settings:manage')) return { label: 'Connect GitHub', href: '#/github' };
  if (can('proposals:create')) return { label: 'Write a proposal', href: '#/proposals' };
  return { label: 'Go to Overview', href: '#/overview' };
}

/** Steps this role can see. */
function visibleSteps(can: (p: Permission) => boolean): Step[] {
  return STEPS.filter((s) => !s.need || can(s.need));
}

/** Role-visible steps a returning user hasn't been shown yet (new features). */
export function hasUnseenOnboarding(can: (p: Permission) => boolean): boolean {
  if (!hasOnboarded()) return false;
  const seen = seenKeys();
  return visibleSteps(can).some((s) => !seen.has(s.key));
}

export function Onboarding({ mode, onClose }: { mode: OnboardingMode; onClose: () => void }): JSX.Element {
  const { can, user } = useAuth();
  const all = visibleSteps(can);
  const seen = seenKeys();
  // Full tour shows everything; "what's new" shows only the unseen steps (and
  // never renders empty — App gates on hasUnseenOnboarding first).
  const steps = mode === 'whatsnew' ? all.filter((s) => !seen.has(s.key)) : all;
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(true);
  const step = steps[Math.min(i, steps.length - 1)]!;
  const last = i === steps.length - 1;
  const cta = finishCta(can);

  const finish = (): void => {
    // Everything this role can currently see is now "seen" — so the next new
    // step (added later) is the only thing that triggers "what's new".
    localStorage.setItem(SEEN_KEY, JSON.stringify(all.map((s) => s.key)));
    onClose();
  };

  // Restart the art animation on each step change (retrigger, reduced-motion safe).
  useEffect(() => {
    setPlaying(false);
    const t = requestAnimationFrame(() => setPlaying(true));
    return () => cancelAnimationFrame(t);
  }, [i]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') finish();
      if (e.key === 'ArrowRight' && !last) setI((n) => n + 1);
      if (e.key === 'ArrowLeft' && i > 0) setI((n) => n - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i, last]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 px-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={mode === 'whatsnew' ? "What's new" : 'Welcome tour'}
    >
      <div className="ob-card w-full max-w-lg overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-800 dark:bg-zinc-950">
        {/* Illustration stage */}
        <div className="relative flex h-48 items-center justify-center overflow-hidden bg-gradient-to-b from-emerald-50 to-white dark:from-emerald-500/10 dark:to-zinc-950">
          {mode === 'whatsnew' ? (
            <span className="absolute top-3 left-4 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
              What's new
            </span>
          ) : null}
          <div key={step.key} className="ob-art">
            {step.art(playing)}
          </div>
          <button
            className="dim absolute top-3 right-3 rounded-md px-2 py-1 text-xs transition-colors hover:bg-white/60 hover:text-zinc-800 dark:hover:bg-zinc-800/60 dark:hover:text-zinc-200"
            onClick={finish}
          >
            {mode === 'whatsnew' ? 'Dismiss' : 'Skip'}
          </button>
        </div>

        {/* Copy */}
        <div className="px-6 pt-5 pb-6">
          <div key={step.key} className="ob-copy min-h-[8.5rem]">
            <h2 className="text-lg font-semibold">{step.title}</h2>
            <p className="dim mt-2 text-[13.5px] leading-relaxed">{step.body}</p>
            {step.chips ? (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {step.chips.map((c) => (
                  <span key={c} className="chip">
                    {c}
                  </span>
                ))}
              </div>
            ) : null}
          </div>

          <div className="mt-5 flex items-center gap-3">
            {/* Progress dots */}
            <div className="flex flex-1 items-center gap-1.5" aria-hidden>
              {steps.map((s, n) => (
                <button
                  key={s.key}
                  className={`h-1.5 rounded-full transition-all ${
                    n === i ? 'w-5 bg-emerald-500' : 'w-1.5 bg-zinc-300 hover:bg-zinc-400 dark:bg-zinc-700 dark:hover:bg-zinc-600'
                  }`}
                  onClick={() => setI(n)}
                  aria-label={`Step ${n + 1}`}
                />
              ))}
            </div>
            {i > 0 ? (
              <button className="btn-ghost" onClick={() => setI((n) => n - 1)}>
                Back
              </button>
            ) : null}
            {last ? (
              // "What's new" is for people already set up — just close; the
              // full first-run tour deep-links to the best next action.
              mode === 'whatsnew' ? (
                <button className="btn" onClick={finish}>
                  Got it
                </button>
              ) : (
                <a className="btn" href={cta.href} onClick={finish}>
                  {cta.label}
                </a>
              )
            ) : (
              <button className="btn" onClick={() => setI((n) => n + 1)}>
                Next
              </button>
            )}
          </div>
          {user && mode === 'full' ? (
            <p className="dim mt-3 text-center text-[11px]">
              You can replay this tour anytime from the <kbd className="rounded border border-zinc-200 px-1 font-mono dark:border-zinc-700">?</kbd> shortcuts help.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ---------- animated step illustrations ----------------------------------------
// Each is a small self-contained SVG; the `ob-*` classes animate under
// prefers-reduced-motion: no-preference and are otherwise static.

function stage(children: JSX.Element): JSX.Element {
  return (
    <svg viewBox="0 0 120 90" fill="none" className="h-36 w-auto text-emerald-600 dark:text-emerald-400" aria-hidden>
      {children}
    </svg>
  );
}

function MascotArt({ playing }: { playing: boolean }): JSX.Element {
  return stage(
    <g className={playing ? 'ob-float' : ''} stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="60" cy="80" rx="20" ry="3" className="ob-shadow" fill="currentColor" stroke="none" opacity="0.18" />
      <path d="M44 30 L39 16 L54 24" />
      <path d="M76 30 L81 16 L66 24" />
      <rect x="36" y="28" width="48" height="34" rx="12" />
      <circle className="ob-eye" cx="52" cy="45" r="3.6" fill="currentColor" stroke="none" />
      <circle className="ob-eye" cx="68" cy="45" r="3.6" fill="currentColor" stroke="none" />
      <path d="M54 53q6 4 12 0" />
    </g>,
  );
}

function LinkArt({ playing }: { playing: boolean }): JSX.Element {
  return stage(
    <g stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="38" cy="45" r="12" />
      <circle cx="82" cy="45" r="12" />
      <path className={playing ? 'ob-dash' : ''} d="M50 45h20" strokeDasharray="4 4" />
      <path d="M34 45h8M78 45h8" />
    </g>,
  );
}

function PlanArt({ playing }: { playing: boolean }): JSX.Element {
  return stage(
    <g stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="30" y="22" width="34" height="46" rx="4" />
      <path d="M37 34h20M37 42h20M37 50h12" className={playing ? 'ob-write' : ''} />
      <path d="M72 30l14 4-4 14-14-4z" className={playing ? 'ob-float' : ''} />
      <path d="M75 36l8 2" />
    </g>,
  );
}

function CodeArt({ playing }: { playing: boolean }): JSX.Element {
  return stage(
    <g stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="34" cy="30" r="5" />
      <circle cx="34" cy="62" r="5" />
      <circle cx="84" cy="62" r="5" />
      <path d="M34 35v22M60 30h14a4 4 0 0 1 4 4v23" />
      <path className={playing ? 'ob-check' : ''} d="M50 46l6 6 12-13" stroke="currentColor" strokeWidth="2.6" />
    </g>,
  );
}

function SparkArt({ playing }: { playing: boolean }): JSX.Element {
  return stage(
    <g className={playing ? 'ob-pulse' : ''} stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round">
      <path d="M60 24l5 14 14 5-14 5-5 14-5-14-14-5 14-5z" fill="currentColor" fillOpacity="0.12" />
      <path d="M82 52l2.5 6 6 2.5-6 2.5-2.5 6-2.5-6-6-2.5 6-2.5z" fill="currentColor" stroke="none" />
    </g>,
  );
}

function RunnersArt({ playing }: { playing: boolean }): JSX.Element {
  return stage(
    <g stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="30" y="24" width="60" height="16" rx="3" />
      <rect x="30" y="48" width="60" height="16" rx="3" />
      <circle className={playing ? 'ob-blink' : ''} cx="38" cy="32" r="2.2" fill="currentColor" stroke="none" />
      <circle className={playing ? 'ob-blink ob-blink-2' : ''} cx="38" cy="56" r="2.2" fill="currentColor" stroke="none" />
      <path d="M48 32h32M48 56h32" opacity="0.5" />
    </g>,
  );
}
