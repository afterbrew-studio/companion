import { Component, type ReactNode } from 'react';
import { useKernel } from '@moxxy/companion-core/client';
import { useAuth } from '@companion/module-core/client';

/**
 * The viewer's landing nav entry (lowest `home` they can see), mirroring the
 * shell's own pick: an escape hatch must never hardcode a module's route, or a
 * build without that module gets a CTA into a 404. Only safe under the shell's
 * providers — the full-page crash fallback links '#/' instead, which the shell
 * redirects to this same entry.
 */
function useLandingNav(): { href: string; label: string } {
  const { can, authMode } = useAuth();
  const kernel = useKernel();
  const landing = kernel.nav
    .filter((m) => can(m.permission) && (!m.authModes || m.authModes.includes(authMode)))
    .sort((a, b) => (a.home ?? Infinity) - (b.home ?? Infinity))[0];
  return landing ? { href: landing.hash, label: landing.label } : { href: '#/', label: 'Home' };
}

/**
 * Error containment. One boundary wraps the whole app (full-page crash
 * fallback — the SPA's "500"), and each feature area gets its own scoped
 * boundary so a bug in one page or panel never takes the shell down with it.
 * Feature boundaries reset when `resetKey` changes (navigation) or via the
 * Try again button.
 */
export class ErrorBoundary extends Component<
  {
    /** Human name of what this boundary guards, e.g. "this page", "AI Help". */
    area?: string;
    /** Full-page fallback (app root) instead of the inline card. */
    full?: boolean;
    /** Changing this clears a caught error — key it by route for pages. */
    resetKey?: string;
    children: ReactNode;
  },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error): void {
    // The fallback shows a terse message; the console keeps the stack.
    console.error(`[companion] ${this.props.area ?? 'app'} crashed:`, error);
  }

  override componentDidUpdate(prev: { resetKey?: string }): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.full) return <CrashPage error={error} />;
    return (
      <FeatureCrash
        area={this.props.area ?? 'this area'}
        error={error}
        onReset={() => this.setState({ error: null })}
      />
    );
  }
}

/** Scoped fallback: the rest of the app keeps working around it. */
function FeatureCrash({ area, error, onReset }: { area: string; error: Error; onReset: () => void }): React.JSX.Element {
  const home = useLandingNav();
  return (
    <div className="mx-auto max-w-lg px-6 py-12 text-center" role="alert">
      <CrashGlyph />
      <h2 className="mt-4 text-base font-semibold">Something went wrong in {area}</h2>
      <p className="dim mx-auto mt-1.5 max-w-sm text-[13px]">
        The rest of Companion is unaffected. If this keeps happening, the daemon log has the details.
      </p>
      <details className="mx-auto mt-3 max-w-md text-left">
        <summary className="dim cursor-pointer text-center text-xs">Technical details</summary>
        <pre className="mono-pane mt-2 max-h-40 text-left">{String(error?.stack ?? error)}</pre>
      </details>
      <div className="mt-5 flex justify-center gap-2">
        <button className="btn" onClick={onReset}>
          Try again
        </button>
        <a className="btn-ghost" href={home.href}>
          Go to {home.label}
        </a>
      </div>
    </div>
  );
}

/** The SPA's "500": only rendered when the shell itself is unrecoverable. */
function CrashPage({ error }: { error: Error }): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="max-w-lg text-center" role="alert">
        <CrashGlyph />
        <div className="mt-4 text-5xl font-bold tracking-tight">500</div>
        <h1 className="mt-2 text-lg font-semibold">Companion hit an unexpected error</h1>
        <p className="dim mx-auto mt-1.5 max-w-sm text-[13px]">
          Reloading usually clears it. If it doesn't, check the daemon log.
        </p>
        <details className="mx-auto mt-3 max-w-md text-left">
          <summary className="dim cursor-pointer text-center text-xs">Technical details</summary>
          <pre className="mono-pane mt-2 max-h-48 text-left">{String(error?.stack ?? error)}</pre>
        </details>
        <div className="mt-6 flex justify-center gap-2">
          <button className="btn" onClick={() => location.reload()}>
            Reload
          </button>
          {/* Outside the shell's providers, so no kernel to ask: '#/' is the
              dynamic fallback — after the reload the shell redirects it to the
              viewer's landing entry. */}
          <a className="btn-ghost" href="#/" onClick={() => setTimeout(() => location.reload(), 0)}>
            Start over & reload
          </a>
        </div>
      </div>
    </div>
  );
}

/** Unknown route: a friendly dead end instead of silently showing the dashboard. */
export function NotFoundPage({ path }: { path: string }): React.JSX.Element {
  const home = useLandingNav();
  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="max-w-md text-center">
        <LostGlyph />
        <div className="mt-4 text-5xl font-bold tracking-tight">404</div>
        <h1 className="mt-2 text-lg font-semibold">This page doesn't exist</h1>
        <p className="dim mt-1.5 text-[13px]">
          <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-[11px] dark:bg-zinc-800">{path}</code>{' '}
          doesn't match any module or detail view.
        </p>
        <div className="mt-6 flex justify-center">
          <a className="btn" href={home.href}>
            Back to {home.label}
          </a>
        </div>
      </div>
    </div>
  );
}

/** A sad little bot — same family as the assistant's mascot, minus the wag. */
function CrashGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 64 64" fill="none" className="mx-auto size-16 text-zinc-400 dark:text-zinc-500" aria-hidden>
      <rect x="14" y="16" width="36" height="28" rx="9" stroke="currentColor" strokeWidth="2" />
      {/* crossed-out eyes */}
      <path d="M24 26l5 5M29 26l-5 5M35 26l5 5M40 26l-5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      {/* flat worried mouth */}
      <path d="M26 38h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      {/* loose antenna */}
      <path d="M32 16c0-4 5-4 6-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M20 50h24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.35" />
    </svg>
  );
}

function LostGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 64 64" fill="none" className="mx-auto size-16 text-zinc-400 dark:text-zinc-500" aria-hidden>
      <rect x="14" y="16" width="36" height="28" rx="9" stroke="currentColor" strokeWidth="2" />
      {/* one raised, puzzled eye */}
      <circle cx="26" cy="29" r="3" fill="rgb(16 185 129)" />
      <path d="M35 26h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      {/* small o mouth */}
      <circle cx="32" cy="38" r="2.2" stroke="currentColor" strokeWidth="1.8" />
      {/* question antenna */}
      <path d="M32 16v-3c0-3 4-3 4-6 0-2-1.6-3-3.4-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M20 50h24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.35" />
    </svg>
  );
}
