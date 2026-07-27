import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspaceVisibility } from '@companion/module-workspace/contract';
import {
  ModulesProvider,
  Slot,
  useKernel,
  matchRoute,
  onServerMessage,
  passesFreshFilters,
  runIntent,
  useIntent,
  type NavEntry,
} from '@companion/core/client';
import {
  AuthProvider,
  useAuth,
  LoginPage,
  SetupPage,
  Onboarding,
  hasOnboarded,
  hasUnseenOnboarding,
  type OnboardingMode,
} from '@companion/module-core/client';
// module-core and module-workspace are `required: true`: every build contains
// them, so the shell may name them. Every OTHER module reaches the shell through
// a `shell.*` slot, which is what lets a build omit it entirely.
import { WorkspaceProvider, useWorkspace, Inbox, workspaceApi, isAmbiguousWorkspaceName } from '@companion/module-workspace/client';
import {
  ChevronDown,
  Dropdown,
  ErrorBar,
  Field,
  FormActions,
  LockIcon,
  Modal,
  PageLoading,
  SearchIcon,
} from '@companion/ui';
import { CommandPalette } from './components/CommandPalette.js';
import { ErrorBoundary, NotFoundPage } from './components/ErrorBoundary.js';
import { ShortcutHelp, useAppShortcuts } from './lib/shortcuts.js';
import { CLIENT_LOADERS } from './modules.generated.js';

/** '#/' when the URL is bare; the Shell then redirects to whichever nav entry
 *  claims the lowest `home`, because the shell owns no page of its own. */
function useHashRoute(): string {
  const [hash, setHash] = useState(location.hash || '#/');
  useEffect(() => {
    const onChange = (): void => setHash(location.hash || '#/');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}

export function App(): JSX.Element {
  return (
    // The app-root boundary is the SPA's 500 page; everything below also has
    // feature-scoped boundaries so one broken area never sinks the shell.
    <ErrorBoundary full>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </ErrorBoundary>
  );
}

/** Login wall: onboarding on clean installs, else login, else the app. */
function Gate(): JSX.Element {
  const { user, needsSetup } = useAuth();
  if (user === undefined) {
    return <div className="dim flex h-full items-center justify-center">Loading…</div>;
  }
  if (needsSetup) return <SetupPage />;
  if (user === null) return <LoginPage />;
  return (
    <WorkspaceProvider>
      <ModulesProvider loaders={CLIENT_LOADERS}>
        <Shell />
      </ModulesProvider>
    </WorkspaceProvider>
  );
}

/** Sidebar brand block: instance logo + name, falling back to the letter tile. */
function Brand({ rail }: { rail: boolean }): JSX.Element {
  const { branding } = useAuth();
  const name = branding.name?.trim() || 'Companion';
  return (
    <div className={`flex items-center gap-2 pt-4 pb-2 ${rail ? 'justify-center px-2' : 'px-4'}`}>
      {branding.logo ? (
        <img src={branding.logo} alt="" className="size-7 shrink-0 rounded-lg object-cover" />
      ) : (
        <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-zinc-900 text-sm font-bold text-white dark:bg-zinc-100 dark:text-zinc-900">
          {name.slice(0, 1).toUpperCase()}
        </div>
      )}
      {rail ? null : <span className="truncate text-[15px] font-semibold">{name}</span>}
    </div>
  );
}

function Shell(): JSX.Element {
  const { user, can, logout, branding } = useAuth();
  const hash = useHashRoute();
  const kernel = useKernel();

  // Route-aware tab title: "Pull Requests · owner/repo · #12 · <instance>".
  useEffect(() => {
    const name = branding.name?.trim() || 'Companion';
    const labels = crumbsFor(hash.replace(/^#/, '').split('?')[0] ?? '/', kernel.nav)
      .map((c) => c.label)
      .join(' · ');
    document.title = labels ? `${labels} · ${name}` : name;
  }, [hash, branding, kernel.nav]);
  const [collapsed, setCollapsed] = useState(localStorage.getItem('companion.sidebar') === 'collapsed');
  // Below md the sidebar is an off-canvas drawer instead of a resizable rail.
  const [mobileOpen, setMobileOpen] = useState(false);
  // Per-group collapse, persisted — the set holds the folded section keys.
  const [foldedSections, setFoldedSections] = useState<ReadonlySet<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('companion.nav-folded') ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  const toggleSection = (section: string): void => {
    setFoldedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      localStorage.setItem('companion.nav-folded', JSON.stringify([...next]));
      return next;
    });
  };

  // Icon-only rail applies to the desktop collapsed state; the mobile drawer
  // always shows full content. Rail items get a styled tooltip: one shared
  // fixed-position element OUTSIDE the aside, so its overflow can't clip it.
  const rail = collapsed && !mobileOpen;
  const [railTip, setRailTip] = useState<{ top: number; left: number; label: string } | null>(null);
  const showRailTip = (e: React.MouseEvent | React.FocusEvent, label: string): void => {
    const r = e.currentTarget.getBoundingClientRect();
    setRailTip({ top: r.top + r.height / 2, left: r.right + 10, label });
  };

  const toggleSidebar = (): void => {
    setRailTip(null);
    if (window.matchMedia('(min-width: 768px)').matches) {
      setCollapsed((c) => {
        localStorage.setItem('companion.sidebar', c ? 'expanded' : 'collapsed');
        return !c;
      });
    } else {
      setMobileOpen((o) => !o);
    }
  };

  const visibleModules = useMemo(() => kernel.nav.filter((m) => can(m.permission)), [kernel.nav, can]);
  const shortcutTargets = useMemo(
    () =>
      visibleModules
        .filter((m) => m.shortcut)
        .map((m) => ({ key: m.shortcut!, label: m.label, hash: m.hash })),
    [visibleModules],
  );
  const { helpOpen, setHelpOpen, chordPending } = useAppShortcuts(shortcutTargets);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Onboarding: the full tour on first entry; a "what's new" popup when new
  // steps have shipped since the user last looked; replayable (full) from the
  // shortcuts help. Steps come from the modules, so the decision waits until the
  // catalog has loaded (kernel.ready) — otherwise "what's new" would see zero
  // steps and never fire. Decided once per session.
  const [tour, setTour] = useState<OnboardingMode | null>(null);
  const tourDecided = useRef(false);
  useEffect(() => {
    if (tourDecided.current || !kernel.ready) return;
    tourDecided.current = true;
    setTour(!hasOnboarded() ? 'full' : hasUnseenOnboarding(kernel.onboarding, can) ? 'whatsnew' : null);
  }, [kernel.ready, kernel.onboarding, can]);
  // Areas with unseen activity, badged in the nav. Scoped and persisted PER
  // workspace: issues/prs activity in another workspace's repos must not light
  // up the one you're looking at, and the marks survive a reload.
  const { current } = useWorkspace();
  const workspaceId = current?.id ?? null;
  const freshKey = workspaceId ? `companion.fresh:${workspaceId}` : null;

  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());

  // Load the active workspace's stored marks when it changes.
  useEffect(() => {
    if (!freshKey) {
      setFresh(new Set());
      return;
    }
    try {
      setFresh(new Set(JSON.parse(localStorage.getItem(freshKey) ?? '[]') as string[]));
    } catch {
      setFresh(new Set());
    }
  }, [freshKey]);

  const mutateFresh = (fn: (prev: Set<string>) => void): void => {
    setFresh((prev) => {
      const next = new Set(prev);
      fn(next);
      if (next.size === prev.size && [...next].every((a) => prev.has(a))) return prev;
      if (freshKey) localStorage.setItem(freshKey, JSON.stringify([...next]));
      return next;
    });
  };

  useEffect(() => {
    return onServerMessage((msg) => {
      // A module may veto a message entirely (code drops activity for repos
      // outside the active workspace); the OWNING nav entry then declares
      // whether it is fresh. The shell knows no message tags of its own.
      if (!passesFreshFilters(msg)) return;
      for (const m of kernel.nav) {
        if (m.freshOn?.(msg) && !location.hash.startsWith(m.hash)) mutateFresh((next) => next.add(m.key));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freshKey, kernel.nav]);

  // The hash can sit under several entries' prefixes (#/playground is a prefix
  // of #/playground/pipelines) — the LONGEST match is the page the user is on,
  // while prefix matching still lights a section for its detail pages
  // (#/runs/:id → Runs). One entry wins everywhere: highlight, title, fresh-clear.
  const activeNavKey = useMemo(() => {
    let best: { key: string; len: number } | null = null;
    for (const m of kernel.nav) {
      const matches =
        hash === m.hash ||
        hash.startsWith(`${m.hash}/`) ||
        hash.startsWith(`${m.hash}?`) ||
        (m.key === 'overview' && hash === '#/');
      if (matches && (best === null || m.hash.length > best.len)) best = { key: m.key, len: m.hash.length };
    }
    return best?.key ?? null;
  }, [kernel.nav, hash]);

  // Visiting an area clears its mark.
  useEffect(() => {
    if (activeNavKey && fresh.has(activeNavKey)) mutateFresh((next) => next.delete(activeNavKey));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNavKey, freshKey]);

  // Cmd/Ctrl+K opens the global search palette from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // AI Help can take the user somewhere or open a form in their own browser.
  useEffect(() => {
    return onServerMessage((msg) => {
      if (msg.t !== 'client.intent') return;
      if (msg.intent) runIntent(msg.intent);
      else if (msg.hash) location.hash = msg.hash;
    });
  }, []);

  // Tapping a nav item (hash change) dismisses the mobile drawer.
  useEffect(() => {
    setMobileOpen(false);
  }, [hash]);

  // Land on the entry that claims the lowest `home`, else the first one the
  // role can see. Which module owns the front page is the modules' business.
  useEffect(() => {
    const path = hash.replace(/^#/, '');
    if (path !== '/' && path !== '') return;
    const landing = [...visibleModules].sort((a, b) => (a.home ?? Infinity) - (b.home ?? Infinity))[0];
    if (landing) location.hash = landing.hash;
  }, [hash, visibleModules]);

  // Group entries into the shared, ordered section namespace the enabled
  // modules declared (module ≠ group); empty groups don't render.
  const sections = useMemo(() => {
    const grouped = new Map<string, NavEntry[]>();
    for (const m of visibleModules) {
      grouped.set(m.section, [...(grouped.get(m.section) ?? []), m]);
    }
    return kernel.sections.filter((s) => grouped.has(s.id)).map((s) => [s, grouped.get(s.id)!] as const);
  }, [kernel.sections, visibleModules]);

  return (
    <div className="flex h-full">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-zinc-900 focus:px-3 focus:py-1.5 focus:text-white dark:focus:bg-zinc-100 dark:focus:text-zinc-900"
      >
        Skip to content
      </a>

      {mobileOpen ? (
        <div className="fixed inset-0 z-30 bg-black/40 md:hidden" aria-hidden onClick={() => setMobileOpen(false)} />
      ) : null}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-56 shrink-0 flex-col overflow-hidden border-r border-zinc-200 bg-zinc-50 transition-[width,transform] duration-200 ease-in-out motion-reduce:transition-none md:static md:translate-x-0 dark:border-zinc-800 dark:bg-zinc-900 md:dark:bg-zinc-900/60 ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        } ${collapsed ? 'md:w-16' : 'md:w-56'}`}
      >
        <Brand rail={rail} />

        <WorkspaceSwitcher rail={rail} />

        <nav className="flex-1 overflow-x-hidden overflow-y-auto px-2.5 pb-3" aria-label="Modules">
          {sections.map(([section, modules], si) => (
            <div key={section.id} className="mt-3">
              {rail ? (
                <div className="mx-2 flex h-5 items-center" aria-hidden>
                  {si > 0 ? <div className="w-full border-t border-zinc-200 dark:border-zinc-800" /> : null}
                </div>
              ) : (
                <button
                  type="button"
                  className="dim flex h-5 w-full cursor-pointer items-end justify-between px-2 pb-1 text-[10px] font-medium tracking-widest uppercase transition-colors hover:text-zinc-700 dark:hover:text-zinc-300"
                  onClick={() => toggleSection(section.id)}
                  aria-expanded={!foldedSections.has(section.id)}
                >
                  {section.label}
                  <ChevronDown open={!foldedSections.has(section.id)} className="size-3" />
                </button>
              )}
              {/* The icon rail ignores folding — hiding icons there saves nothing. */}
              {!rail && foldedSections.has(section.id)
                ? null
                : modules.map((m) => {
                // Longest-match winner computed once above — boundary-aware
                // (#/runners never lights #/runs) and nesting-aware
                // (#/playground/pipelines lights only Pipeline Lab).
                const active = m.key === activeNavKey;
                return (
                  <a
                    key={m.key}
                    href={m.hash}
                    aria-current={active ? 'page' : undefined}
                    aria-label={rail ? m.label : undefined}
                    onMouseEnter={rail ? (e) => showRailTip(e, m.label) : undefined}
                    onMouseLeave={rail ? () => setRailTip(null) : undefined}
                    onFocus={rail ? (e) => showRailTip(e, m.label) : undefined}
                    onBlur={rail ? () => setRailTip(null) : undefined}
                    className={`relative flex items-center gap-2.5 rounded-lg py-1.5 text-[13px] ${
                      rail ? 'justify-center px-0' : 'px-2.5'
                    } ${
                      active
                        ? 'bg-zinc-900 font-medium text-white dark:bg-zinc-700 dark:text-zinc-50'
                        : 'text-zinc-700 hover:bg-zinc-200 dark:text-zinc-300 dark:hover:bg-zinc-800'
                    }`}
                  >
                    <span className="relative shrink-0">
                      {m.icon}
                      {/* Collapsed rail has no room for a label — a corner dot is
                          the only affordance; the expanded row uses a pill. */}
                      {rail && fresh.has(m.key) ? (
                        <span
                          className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-[#2a78d6] ring-2 ring-zinc-50 dark:bg-[#3987e5] dark:ring-zinc-900"
                          role="status"
                          aria-label={`New activity in ${m.label}`}
                        />
                      ) : null}
                    </span>
                    {rail ? null : (
                      <>
                        <span className="flex-1 truncate">{m.label}</span>
                        {fresh.has(m.key) ? (
                          <span
                            className="rounded-full bg-[#2a78d6] px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-white uppercase dark:bg-[#3987e5]"
                            role="status"
                            aria-label={`New activity in ${m.label}`}
                          >
                            New
                          </span>
                        ) : (
                          <kbd
                            className={`hidden rounded px-1 font-mono text-[10px] lg:inline ${
                              active ? 'bg-white/20 dark:bg-white/10' : 'text-zinc-400 dark:text-zinc-500'
                            }`}
                            aria-hidden
                          >
                            g{m.shortcut}
                          </kbd>
                        )}
                      </>
                    )}
                  </a>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
          {rail ? (
            // Icon-only: just the profile glyph, centered — sign out lives in
            // the expanded sidebar.
            <div className="-mx-2 flex justify-center">
              <a
                href="#/profile"
                className="flex w-fit items-center rounded-lg p-1.5 transition-colors hover:bg-zinc-200 dark:hover:bg-zinc-800"
                aria-label="Open your profile"
                title={`${user?.displayName ?? ''} — open your profile`}
              >
                <span className="flex size-8 items-center justify-center rounded-lg bg-zinc-200 text-[13px] font-semibold uppercase dark:bg-zinc-800">
                  {(user?.displayName ?? '?').slice(0, 1)}
                </span>
              </a>
            </div>
          ) : (
            <div className="-mx-2 flex items-center gap-1">
              <a
                href="#/profile"
                className="dim min-w-0 flex-1 cursor-pointer rounded-lg px-2 py-1.5 text-zinc-700 transition-colors hover:bg-zinc-200 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                title="Open your profile"
              >
                <div className="truncate text-[13px] font-medium">{user?.displayName}</div>
                <div className="text-[11px] capitalize">{user?.role}</div>
              </a>
              <button
                className="dim flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors hover:bg-zinc-200 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                onClick={() => void logout()}
                aria-label="Sign out"
                title={`Sign out ${user?.displayName ?? ''}`}
              >
                <SignOutIcon />
              </button>
            </div>
          )}
        </div>
      </aside>

      {railTip ? (
        <div
          role="tooltip"
          className="anim-in pointer-events-none fixed z-50 -translate-y-1/2 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs font-medium whitespace-nowrap text-zinc-700 shadow-md dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
          style={{ top: railTip.top, left: railTip.left }}
        >
          {railTip.label}
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <Slot name="shell.banner" can={can} />
        <TopBar
          hash={hash}
          chordPending={chordPending}
          collapsed={collapsed}
          onToggleSidebar={toggleSidebar}
          onOpenPalette={() => setPaletteOpen(true)}
        />
        <main id="main" className="min-h-0 flex-1 overflow-y-auto">
          {/* Keyed by route: navigating away from a crashed page recovers it. */}
          <ErrorBoundary area="this page" resetKey={hash}>
            <RouterView hash={hash} />
          </ErrorBoundary>
        </main>
      </div>

      {paletteOpen ? <CommandPalette onClose={() => setPaletteOpen(false)} /> : null}
      {helpOpen ? (
        <ShortcutHelp
          targets={shortcutTargets}
          onClose={() => setHelpOpen(false)}
          onReplayTour={() => {
            setHelpOpen(false);
            setTour('full');
          }}
        />
      ) : null}
      {tour ? <Onboarding steps={kernel.onboarding} mode={tour} onClose={() => setTour(null)} /> : null}
    </div>
  );
}

/**
 * The whole section is the click target: avatar tile + caption + name opens a
 * searchable workspace menu. Rail mode renders an empty slot of the same
 * vertical footprint, so collapsing never makes the nav below jump.
 */
function WorkspaceSwitcher({ rail }: { rail: boolean }): JSX.Element {
  const { workspaces, current, setCurrent, refresh } = useWorkspace();
  const { can } = useAuth();
  const [creating, setCreating] = useState(false);
  // ⌘K → "Create workspace" opens this modal even when the rail is collapsed.
  useIntent('new-workspace', () => can('workspaces:create') && setCreating(true));
  const createModal =
    creating && can('workspaces:create') ? (
      <NewWorkspaceModal
        canPublic={can('workspaces:manage')}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          void refresh().then(() => setCurrent(id));
        }}
      />
    ) : null;
  if (rail) {
    // Collapsed: no glyph — just hold the switcher's slot so the nav below
    // doesn't shift; the ⌘K "Create workspace" intent stays live.
    return (
      <div className="px-2.5 pt-3 pb-1">
        <div className="h-12" aria-hidden />
        {createModal}
      </div>
    );
  }
  return (
    <div className="px-2.5 pt-3 pb-1">
      <Dropdown
        ariaLabel="Active workspace"
        value={current?.id ?? null}
        onChange={setCurrent}
        placeholder="No workspaces"
        searchable
        triggerClassName="flex h-12 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 text-left transition-colors hover:bg-zinc-200 dark:hover:bg-zinc-800"
        renderTrigger={(selected, open) => (
          <>
            <span className="min-w-0 flex-1">
              {/* On a name collision the slug rides the roomy eyebrow line —
                  appended to the name it would just truncate away. */}
              <span className="dim block truncate text-[10px] font-medium tracking-widest uppercase">
                Workspace
                {current && isAmbiguousWorkspaceName(current, workspaces) ? ` · ${current.slug}` : ''}
              </span>
              <span className="flex items-center gap-1.5">
                {current?.visibility === 'private' ? <LockIcon className="dim size-3.5" /> : null}
                <span className="block truncate text-[13px] font-medium">{selected?.label ?? 'No workspaces'}</span>
              </span>
            </span>
            <ChevronDown open={open} />
          </>
        )}
        options={workspaces.map((w) => ({
          value: w.id,
          label: w.name,
          // Colliding names carry the slug in the hint — searchable, and the
          // menu is wide enough that it never truncates the name itself.
          hint: `${isAmbiguousWorkspaceName(w, workspaces) ? `${w.slug} · ` : ''}${w.repoCount} ${w.repoCount === 1 ? 'repo' : 'repos'}${w.visibility === 'private' ? ' · private' : ''}`,
        }))}
        action={can('workspaces:create') ? { label: 'New workspace', onSelect: () => setCreating(true) } : undefined}
      />
      {createModal}
    </div>
  );
}

function NewWorkspaceModal({
  canPublic,
  onClose,
  onCreated,
}: {
  /** Only admins (workspaces:manage) may create a public, shared-with-everyone workspace. */
  canPublic: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}): JSX.Element {
  const [name, setName] = useState('');
  // Admins default to public (their historic shared workspaces); everyone else
  // gets a private workspace they own.
  const [visibility, setVisibility] = useState<WorkspaceVisibility>(canPublic ? 'public' : 'private');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { workspace } = await workspaceApi.createWorkspace(name.trim(), { visibility });
      onCreated(workspace.id);
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="New workspace" onClose={onClose}>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <Field label="Name">
          <input
            className="input"
            required
            minLength={2}
            maxLength={80}
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="dim mb-1 text-sm">Visibility</legend>
          <label
            className={`flex items-center gap-2 text-sm ${canPublic ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'}`}
          >
            <input
              type="radio"
              name="visibility"
              checked={visibility === 'public'}
              disabled={!canPublic}
              onChange={() => setVisibility('public')}
            />
            Public
            <span className="dim text-xs">
              — shared with everyone{canPublic ? '' : ' (admins only)'}
            </span>
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="radio"
              name="visibility"
              checked={visibility === 'private'}
              onChange={() => setVisibility('private')}
            />
            Private
            <span className="dim text-xs">— just you, plus anyone you invite</span>
          </label>
        </fieldset>
        <ErrorBar error={error} />
        <FormActions>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" type="submit" disabled={busy || name.trim().length < 2}>
            {busy ? 'Creating…' : 'Create workspace'}
          </button>
        </FormActions>
      </form>
    </Modal>
  );
}

/** The list hash including the tab the user last had open (survives detail visits). */
function listBackHref(base: '#/prs' | '#/issues'): string {
  const state = sessionStorage.getItem(`companion.tab:${base}`);
  return state && state !== 'open' ? `${base}?state=${state}` : base;
}

/** Route-derived crumbs: module label first, then detail segments. */
function crumbsFor(path: string, nav: readonly NavEntry[]): Array<{ label: string; href?: string }> {
  let m = path.match(/^\/runs\/([A-Za-z0-9_-]+)$/);
  if (m) return [{ label: 'Agent Runs', href: '#/runs' }, { label: m[1]! }];
  m = path.match(/^\/repos\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)$/);
  if (m) return [{ label: 'Issues', href: listBackHref('#/issues') }, { label: `${m[1]}/${m[2]}` }, { label: `#${m[3]}` }];
  m = path.match(/^\/repos\/([\w.-]+)\/([\w.-]+)\/prs\/(\d+)$/);
  if (m) return [{ label: 'Pull Requests', href: listBackHref('#/prs') }, { label: `${m[1]}/${m[2]}` }, { label: `#${m[3]}` }];
  // Standalone pages outside the module registry.
  if (path === '/inbox') return [{ label: 'Inbox' }];
  if (path === '/profile') return [{ label: 'Your profile' }];
  // Boundary-aware AND longest-match: /runners must not resolve to Agent Runs,
  // and /playground/pipelines must resolve to Pipeline Lab, not Agent Lab.
  let mod: NavEntry | undefined;
  for (const mm of nav) {
    const base = mm.hash.slice(1);
    if ((path === base || path.startsWith(`${base}/`)) && (mod === undefined || mm.hash.length > mod.hash.length)) {
      mod = mm;
    }
  }
  return [{ label: mod?.label ?? 'Overview' }];
}

function TopBar({
  hash,
  chordPending,
  collapsed,
  onToggleSidebar,
  onOpenPalette,
}: {
  hash: string;
  chordPending: boolean;
  collapsed: boolean;
  onToggleSidebar: () => void;
  onOpenPalette: () => void;
}): JSX.Element {
  const { can } = useAuth();
  const kernel = useKernel();
  const path = hash.replace(/^#/, '').split('?')[0] ?? '/';
  const crumbs = crumbsFor(path, kernel.nav);
  return (
    <div className="flex h-11 shrink-0 items-center gap-3 border-b border-zinc-200 px-4 dark:border-zinc-800">
      <button
        type="button"
        className="dim -ml-1 cursor-pointer rounded-md p-1 hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        onClick={onToggleSidebar}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-expanded={!collapsed}
      >
        <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden>
          <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.2" />
          <path d="M6 2.5v11" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </button>
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-[13px]">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <span key={`${c.label}-${i}`} className="flex min-w-0 items-center gap-1.5">
              {c.href && !last ? (
                <a href={c.href} className="dim shrink-0 hover:text-zinc-800 dark:hover:text-zinc-200">
                  {c.label}
                </a>
              ) : (
                <span className={last ? 'truncate font-medium' : 'dim shrink-0'}>{c.label}</span>
              )}
              {!last ? (
                <span className="dim select-none" aria-hidden>
                  /
                </span>
              ) : null}
            </span>
          );
        })}
      </nav>
      <span className="flex-1" />
      {chordPending ? (
        <span className="dim text-xs" role="status">
          g … waiting for module key
        </span>
      ) : null}
      <button
        type="button"
        className="dim flex w-44 cursor-pointer items-center gap-2 rounded-lg border border-zinc-200 px-2.5 py-1.5 text-xs transition-colors hover:border-zinc-300 hover:text-zinc-700 max-sm:w-auto dark:border-zinc-800 dark:hover:border-zinc-600 dark:hover:text-zinc-300"
        onClick={onOpenPalette}
        aria-label="Search (Cmd+K)"
      >
        <SearchIcon />
        <span className="flex-1 text-left max-sm:hidden">Search…</span>
        <kbd className="rounded border border-zinc-200 px-1 font-mono text-[10px] max-sm:hidden dark:border-zinc-700">
          ⌘K
        </kbd>
      </button>
      <Inbox />
      <Slot name="shell.topbar" can={can} />
    </div>
  );
}

function SignOutIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden>
      <path
        d="M6 2.5H4a1.5 1.5 0 0 0-1.5 1.5v8A1.5 1.5 0 0 0 4 13.5h2M10.5 11l3-3-3-3M13.5 8H6"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}


/**
 * The data-driven router: matches the hash against the enabled modules'
 * compiled route table (whole-segment specificity — declaration order is
 * irrelevant), guards by permission, and lazy-loads the page chunk under
 * Suspense. A path no enabled module claims is a 404.
 */
function RouterView({ hash }: { hash: string }): JSX.Element {
  const { can } = useAuth();
  const kernel = useKernel();
  const path = hash.replace(/^#/, '').split('?')[0] ?? '/';
  const query = useMemo(() => new URLSearchParams(hash.split('?')[1] ?? ''), [hash]);
  // First paint: the shell renders instantly; routes resolve when the enabled
  // modules' (tiny) client chunks land.
  if (!kernel.ready) return <PageLoading />;
  const hit = matchRoute(kernel.routes, path);
  if (!hit) return <NotFoundPage path={path} />;
  if (hit.route.permission && !can(hit.route.permission)) return <NoAccess />;
  const Page = hit.route.component;
  return (
    <Suspense fallback={<PageLoading />}>
      <Page params={hit.params} query={query} />
    </Suspense>
  );
}

function NoAccess(): JSX.Element {
  return (
    <div className="mx-auto max-w-md px-6 py-16 text-center">
      <h1 className="text-lg font-semibold">No access</h1>
      <p className="dim mt-2">Your account&apos;s role does not include this area.</p>
    </div>
  );
}
