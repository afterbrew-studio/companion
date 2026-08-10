import type { ComponentType, ReactNode } from 'react';
import type {
  NavigationAudience,
  NavigationPageOverride,
  Permission,
  SpaServerMessage,
} from '@moxxy/companion-contracts';
import type { ModuleManifest } from '../manifest.js';
import type { QuickAction } from './quick-actions.js';

/**
 * `@moxxy/companion-core/client` — the client-side registrant API a module's `/client`
 * slice is authored against. The web host (ModulesProvider, route compiler, the
 * single-socket net layer, `useLive`) is added here during the web rewire; it is
 * consumed only by `apps/web` and module hooks. Vite reads this as source.
 */

/** Sidebar groups — a shared, ordered namespace addressed by id (module ≠ group). */
export type SectionId =
  | 'workspace'
  | 'workspace-manage'
  | 'plan'
  | 'code'
  | 'operate'
  | 'more'
  // Settings-shell groups, all owned by core so a module can attach to one
  // without depending on whoever else uses it. A typo here is not a type error
  // (the union stays open), it is an entry that never renders.
  | 'admin'
  | 'admin-ai'
  | 'admin-access'
  | 'admin-integrations'
  | (string & {});

export interface NavSection {
  readonly id: SectionId;
  readonly label: string;
  readonly order: number;
  readonly permission?: Permission;
  /**
   * Where the group renders. 'settings' moves instance configuration into the
   * settings shell; 'catalog' keeps specialist tools searchable without giving
   * them permanent sidebar rows. Entries and routes are untouched by this:
   * only the chrome around them changes. Defaults to 'sidebar'.
   */
  readonly placement?: 'sidebar' | 'settings' | 'catalog';
  /** Progressive disclosure for secondary surfaces; an active route still unfolds it. */
  readonly defaultCollapsed?: boolean;
  /**
   * Menu presets that include this group. Omit for a shared group shown in
   * every preset. This is presentation only: RBAC still decides access, Search
   * still exposes every permitted route, and Admin intentionally includes all
   * permitted sidebar groups.
   */
  readonly audiences?: readonly NavigationAudience[];
}

export interface NavEntry {
  readonly key: string;
  readonly label: string;
  readonly hash: string;
  readonly section: SectionId;
  readonly permission: Permission;
  readonly icon: ReactNode;
  /** Hide account-administration surfaces in trusted local mode without
   * changing their routes or RBAC. Omit when a page applies in both modes. */
  readonly authModes?: readonly import('@moxxy/companion-contracts').AuthMode[];
  /** `g` + this key jumps to the entry. */
  readonly shortcut?: string;
  readonly order?: number;
  /**
   * Optional refinement inside an included sidebar group. Omit for a page
   * shared by every menu view. Admin always includes every permitted entry.
   * This never affects routes, Search, shortcuts, or authorization.
   */
  readonly audiences?: readonly NavigationAudience[];
  /** Nest under another entry (by its key). */
  readonly parent?: string;
  /**
   * Detail pages this entry owns whose path does NOT sit under its own hash,
   * matched against the path (no `#`, no query).
   *
   * A pull request lives at `/repos/:owner/:name/prs/:n`, so prefix matching
   * alone lights Repositories while the user is looking at a pull request.
   * Only the entry itself knows which detail pages belong to it, which is why
   * the claim is declared here rather than guessed by the shell. An explicit
   * claim beats any incidental prefix.
   */
  readonly owns?: readonly RegExp[];
  /** Nav "new activity" badge: a marker string on a matching live message, else null. */
  readonly freshOn?: (msg: SpaServerMessage) => string | null;
  /**
   * Candidate landing page for a bare URL, lowest number wins. The shell has no
   * business knowing which module owns "the front page": in a build without that
   * module the next-best permitted entry has to take over, and hardcoding one
   * makes every narrower profile land on a 404.
   */
  readonly home?: number;
}

/** Resolve one sidebar row from the selected preset plus that user's explicit
 * per-preset deviation. This is shared by the shell and Profile so the switches
 * always describe exactly what the sidebar will render. */
export function navigationEntryVisible(
  entry: NavEntry,
  section: NavSection | undefined,
  perspective: NavigationAudience,
  overrides: readonly NavigationPageOverride[],
): boolean {
  if (!section) return false;
  const sectionMatches = section.audiences === undefined || section.audiences.includes(perspective);
  const entryMatches = entry.audiences === undefined || entry.audiences.includes(perspective);
  const presetVisible = perspective === 'admin' || (sectionMatches && entryMatches);
  return overrides.find((override) => override.perspective === perspective && override.key === entry.key)?.visible
    ?? presetVisible;
}

/** Whole-segment route matching — no manual ordering (kills the /runners-vs-/runs hazard). */
export type RouteMatch =
  | { readonly exact: string }
  | { readonly prefix: string }
  | { readonly regex: RegExp; params(m: RegExpMatchArray): Record<string, string> };

export interface RouteProps {
  readonly params: Record<string, string>;
  readonly query: URLSearchParams;
}

export interface ClientRoute {
  readonly match: RouteMatch;
  readonly permission?: Permission;
  /** Lazy so each heavy page is its own Vite chunk. */
  readonly component: ComponentType<RouteProps>;
}

/** Render INTO another module's page (extension point) via inversion of control. */
export interface SlotContribution {
  readonly slot: string;
  readonly key: string;
  readonly order?: number;
  readonly permission?: Permission;
  readonly component: ComponentType<Record<string, unknown>>;
}

/**
 * One card in the welcome tour / "what's new" popup. A module contributes the
 * step for its own feature — with its OWN (compile-checked) permission, so there
 * is no cross-module permission cast — and the host aggregates them by `order`
 * into a single narrative. `art` draws inside the shared `OnboardingArt` frame.
 */
export interface OnboardingStep {
  readonly key: string;
  /** Position in the tour (ascending). Leave gaps so modules can slot between. */
  readonly order: number;
  /** Hide unless the viewer holds this permission (the contributing module's own). */
  readonly permission?: Permission;
  readonly title: string;
  readonly body: string;
  readonly chips?: readonly string[];
  readonly art: (playing: boolean) => ReactNode;
  /** If this is the most-advanced step the viewer can act on, the finish button
   *  deep-links here (lowest-order eligible step wins). */
  readonly cta?: { readonly label: string; readonly href: string };
}

/** The `/client` barrel of a module. */
export interface WebModule {
  readonly manifest: ModuleManifest;
  readonly sections?: readonly NavSection[];
  readonly nav?: readonly NavEntry[];
  readonly routes?: readonly ClientRoute[];
  readonly slots?: readonly SlotContribution[];
  readonly onboarding?: readonly OnboardingStep[];
  /** Outcome-oriented actions shown in the global New menu and command palette. */
  readonly quickActions?: readonly QuickAction[];
}

// ---- registrants ----
export const defineSections = (s: readonly NavSection[]): readonly NavSection[] => s;
export const defineNav = (e: readonly NavEntry[]): readonly NavEntry[] => e;
export const defineClientRoutes = (r: readonly ClientRoute[]): readonly ClientRoute[] => r;
export const defineSlots = (s: readonly SlotContribution[]): readonly SlotContribution[] => s;
export const defineOnboarding = (s: readonly OnboardingStep[]): readonly OnboardingStep[] => s;
export const defineClientModule = (m: WebModule): WebModule => m;

/** The shared 120×90 illustration frame every onboarding step draws inside, so a
 *  module's tour art matches the tour's visual language (emerald, ob-* motion). */
export function OnboardingArt({ children }: { children: ReactNode }): ReactNode {
  return (
    <svg viewBox="0 0 120 90" fill="none" className="h-36 w-auto text-emerald-600 dark:text-emerald-400" aria-hidden>
      {children}
    </svg>
  );
}

// ---- the web host: single-socket net core, live loop, route matcher, module host ----
export * from './net.js';
export * from './live.js';
export * from './router.js';
export * from './lazy.js';
export * from './modules-provider.js';

// ---- client logic primitives shared across module slices ----
export * from './intents.js';
export * from './links.js';
export * from './use-bulk-runner.js';
export * from './nav-icon.js';
export * from './fresh.js';
export * from './cached-resource.js';
export * from './slot.js';
export * from './quick-actions.js';
