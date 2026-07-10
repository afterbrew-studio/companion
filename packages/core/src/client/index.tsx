import type { ComponentType, ReactNode } from 'react';
import type { Permission, SpaServerMessage } from '@companion/contracts';
import type { ModuleManifest } from '../manifest.js';

/**
 * `@companion/core/client` — the client-side registrant API a module's `/client`
 * slice is authored against. The web host (ModulesProvider, route compiler, the
 * single-socket net layer, `useLive`) is added here during the web rewire; it is
 * consumed only by `apps/web` and module hooks. Vite reads this as source.
 */

/** Sidebar groups — a shared, ordered namespace addressed by id (module ≠ group). */
export type SectionId = 'workspace' | 'plan' | 'code' | 'operate' | 'admin' | (string & {});

export interface NavSection {
  readonly id: SectionId;
  readonly label: string;
  readonly order: number;
  readonly permission?: Permission;
}

export interface NavEntry {
  readonly key: string;
  readonly label: string;
  readonly hash: string;
  readonly section: SectionId;
  readonly permission: Permission;
  readonly icon: ReactNode;
  /** `g` + this key jumps to the entry. */
  readonly shortcut?: string;
  readonly order?: number;
  /** Nest under another entry (by its key). */
  readonly parent?: string;
  /** Nav "new activity" badge: a marker string on a matching live message, else null. */
  readonly freshOn?: (msg: SpaServerMessage) => string | null;
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

/** The `/client` barrel of a module. */
export interface WebModule {
  readonly manifest: ModuleManifest;
  readonly sections?: readonly NavSection[];
  readonly nav?: readonly NavEntry[];
  readonly routes?: readonly ClientRoute[];
  readonly slots?: readonly SlotContribution[];
}

// ---- registrants ----
export const defineSections = (s: readonly NavSection[]): readonly NavSection[] => s;
export const defineNav = (e: readonly NavEntry[]): readonly NavEntry[] => e;
export const defineClientRoutes = (r: readonly ClientRoute[]): readonly ClientRoute[] => r;
export const defineSlots = (s: readonly SlotContribution[]): readonly SlotContribution[] => s;
export const defineClientModule = (m: WebModule): WebModule => m;

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
