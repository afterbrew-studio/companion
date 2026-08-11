import { useEffect, useState } from 'react';
import { useKernel, type OnboardingStep } from '@moxxy/companion-core/client';
import type { Permission } from '@moxxy/companion-contracts';
import { useAuth } from '../lib/auth.js';

/**
 * Optional product tour: short, animated, and skippable. Two modes off one
 * step list remain available to hosts:
 *
 *  - `full` — the whole tour, opened explicitly from shortcut help.
 *  - `whatsnew` — only steps a returning user has not marked as seen.
 *
 * The steps are NOT defined here: each module contributes its own step (with its
 * own compile-checked permission) via `defineOnboarding`, and the shell hands us
 * `useKernel().onboarding` — already ordered and covering only enabled modules.
 * Steps are role-aware (a step whose declared permission the user lacks is
 * dropped, and a step declaring `withoutPermission` shows only to viewers who
 * lack that permission), and the finish button deep-links to the most useful
 * next action. Seen step keys are remembered in localStorage; the shell opens
 * the full tour automatically on a browser's first visit (gated on
 * `hasOnboarded`) and never again after dismissal.
 */

const SEEN_KEY = 'companion.onboarding.seen';

function seenKeys(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) ?? 'null') as string[]);
  } catch {
    return new Set();
  }
}

/** True once the user has completed or skipped the optional tour at least once. */
export function hasOnboarded(): boolean {
  return localStorage.getItem(SEEN_KEY) !== null;
}

export type OnboardingMode = 'full' | 'whatsnew';

/** Steps this role can see. */
function visibleSteps(steps: readonly OnboardingStep[], can: (p: Permission) => boolean): OnboardingStep[] {
  return steps.filter(
    (s) => (!s.permission || can(s.permission)) && (!s.withoutPermission || !can(s.withoutPermission)),
  );
}

/** The best first action for the role: the lowest-order visible step that
 *  declares a `cta`, else the viewer's landing nav entry. */
function finishCta(
  steps: readonly OnboardingStep[],
  can: (p: Permission) => boolean,
  fallback: { label: string; href: string },
): { label: string; href: string } {
  const step = visibleSteps(steps, can).find((s) => s.cta);
  return step?.cta ?? fallback;
}

export function Onboarding({
  steps,
  mode,
  onClose,
}: {
  steps: readonly OnboardingStep[];
  mode: OnboardingMode;
  onClose: () => void;
}): React.JSX.Element {
  const { can, user, authMode } = useAuth();
  const kernel = useKernel();
  const all = visibleSteps(steps, can);
  const seen = seenKeys();
  // Full tour shows everything; "what's new" shows only the unseen steps (a
  // host using it must gate on unseen steps existing, or it renders empty).
  const shown = mode === 'whatsnew' ? all.filter((s) => !seen.has(s.key)) : all;
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(true);
  const step = shown[Math.min(i, shown.length - 1)]!;
  const last = i === shown.length - 1;
  // No module route is hardcoded in the finish fallback: it points at the
  // viewer's landing nav entry, whatever this build and role contain.
  const landing = kernel.nav
    .filter((m) => can(m.permission) && (!m.authModes || m.authModes.includes(authMode)))
    .sort((a, b) => (a.home ?? Infinity) - (b.home ?? Infinity))[0];
  const cta = finishCta(
    steps,
    can,
    landing ? { label: `Go to ${landing.label}`, href: landing.hash } : { label: 'Get started', href: '#/' },
  );

  const finish = (): void => {
    // Everything this role can currently see is now "seen" for a host that
    // chooses to expose the optional "what's new" mode.
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
            {/* Progress dots: real jump targets, so they must stay in the
                accessibility tree (focusable content inside aria-hidden is a
                contradiction assistive tech surfaces as a broken control). */}
            <div className="flex flex-1 items-center gap-1.5" role="group" aria-label="Tour progress">
              {shown.map((s, n) => (
                <button
                  key={s.key}
                  type="button"
                  className={`h-1.5 rounded-full transition-all ${
                    n === i ? 'w-5 bg-emerald-500' : 'w-1.5 bg-zinc-300 hover:bg-zinc-400 dark:bg-zinc-700 dark:hover:bg-zinc-600'
                  }`}
                  onClick={() => setI(n)}
                  aria-label={`Step ${n + 1} of ${shown.length}: ${s.title}`}
                  aria-current={n === i ? 'step' : undefined}
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
