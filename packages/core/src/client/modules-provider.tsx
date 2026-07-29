import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ModuleConfigField } from '../module-config.js';
import { request, onServerMessage } from './net.js';
import { compileRoutes } from './router.js';
import type { ClientRoute, NavEntry, NavSection, OnboardingStep, SlotContribution, WebModule } from './index.js';

/**
 * The web module host. Fetches the installed-module catalog, dynamic-imports
 * ONLY the enabled modules' `/client` chunks (Vite code-splits one per module;
 * a disabled module's JS is never fetched), aggregates their nav/routes/slots,
 * and re-aggregates live on `modules.changed`. RBAC filtering deliberately does
 * NOT happen here — the shell presents nav/routes filtered by `can()`.
 */

/** One catalog module as reported by GET /api/modules (no code loaded) — mirrors ModuleListing. */
export interface ModuleDescriptor {
  readonly id: string;
  readonly title: string;
  readonly version: string;
  readonly dependsOn: readonly string[];
  readonly required: boolean;
  /** false ⇒ "Available": compiled into the app but not adopted (no tables, no routes). */
  readonly installed: boolean;
  readonly enabled: boolean;
  /** Every required config field has a stored value or a default. */
  readonly configured: boolean;
  readonly permissions: readonly string[];
  /** The declared config field spec (metadata only — never values). */
  readonly config: readonly ModuleConfigField[];
  /** Entitlement this module needs, or null when it is unlicensed OSS. */
  readonly entitlement: string | null;
  /** false ⇒ declared an entitlement this instance's licence does not grant. */
  readonly entitled: boolean;
  /** Out-of-tree module: its files live in the daemon's modules directory, so an
   *  admin can add and remove them without a new build. */
  readonly external: boolean;
  /** Out-of-tree module: its client chunk is fetched from the daemon, not bundled. */
  readonly externalClient: boolean;
}

export type ClientLoader = () => Promise<{ readonly default: WebModule }>;

/**
 * Fetch an out-of-tree module's prebuilt chunk.
 *
 * Vite cannot code-split a package it did not know about at build time, so this
 * is a raw dynamic import of a URL the daemon serves. `@vite-ignore` keeps the
 * bundler from trying to resolve it; the version query busts the browser cache
 * when a module is upgraded in place, which is otherwise a very confusing bug
 * (new server, old UI, no error).
 *
 * The chunk's own bare imports (`react`, the SDK subpaths) resolve through the
 * import map in index.html to the host's modules. Without that map the browser
 * cannot resolve them at all, which fails loudly. That is deliberate: the
 * alternative failure, a second React, throws from inside hooks with a stack
 * that points nowhere near the cause.
 */
const loadExternalClient = (d: ModuleDescriptor): Promise<{ readonly default: WebModule }> =>
  import(/* @vite-ignore */ `/modules/${d.id}/client.js?v=${encodeURIComponent(d.version)}`) as Promise<{
    readonly default: WebModule;
  }>;

export interface KernelState {
  /** The whole compiled catalog (installed or merely available) — feeds the Modules admin page. */
  readonly descriptors: readonly ModuleDescriptor[];
  /** Loaded, enabled client modules. */
  readonly modules: readonly WebModule[];
  /** False until the first catalog fetch + chunk loads resolve. */
  readonly ready: boolean;
  /** Sidebar groups: deduped by id, sorted by order. */
  readonly sections: readonly NavSection[];
  /** Aggregated nav entries (unfiltered — the shell applies `can()`). */
  readonly nav: readonly NavEntry[];
  /** Aggregated routes, specificity-compiled for `matchRoute`. */
  readonly routes: readonly ClientRoute[];
  /** Contributions for a named in-page slot, sorted by order. */
  slots(name: string): readonly SlotContribution[];
  /** Welcome-tour steps from all enabled modules, ordered into one narrative. */
  readonly onboarding: readonly OnboardingStep[];
}

const KernelContext = createContext<KernelState | null>(null);

export function ModulesProvider(props: {
  readonly loaders: Readonly<Record<string, ClientLoader>>;
  readonly children: ReactNode;
}): ReactNode {
  const [descriptors, setDescriptors] = useState<readonly ModuleDescriptor[]>([]);
  const [modules, setModules] = useState<readonly WebModule[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped per load; a stale (slower) load discards its result so an out-of-order
  // response can't overwrite a newer catalog.
  const seq = useRef(0);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      const mine = ++seq.current;
      try {
        const { modules: catalog } = await request<{ modules: ModuleDescriptor[] }>('/api/modules');
        if (!alive || mine !== seq.current) return;
        const enabled = catalog.filter((m) => m.enabled && (props.loaders[m.id] || m.externalClient));
        // One bad out-of-tree chunk must not blank the whole shell, so external
        // loads are settled and reported, not awaited as a group. A compiled-in
        // loader failing is a build problem and still aborts: there is no
        // degraded state worth showing for that.
        const loaded = (
          await Promise.all(
            enabled.map(async (m) => {
              const compiled = props.loaders[m.id];
              if (compiled) return (await compiled()).default;
              try {
                return (await loadExternalClient(m)).default;
              } catch (err) {
                console.error(`[companion] module '${m.id}' has no usable client chunk`, err);
                return null;
              }
            }),
          )
        ).filter((m): m is WebModule => m !== null);
        if (!alive || mine !== seq.current) return;
        setDescriptors(catalog);
        setModules(loaded);
        setError(null);
        setReady(true);
      } catch (err) {
        if (!alive || mine !== seq.current) return;
        // Don't strand the shell on a spinner: surface the failure so the user
        // can retry (transient daemon blip, or a chunk 404 after a redeploy).
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    const off = onServerMessage((msg) => {
      if (msg.t === 'modules.changed') void load();
    });
    return () => {
      alive = false;
      off();
    };
  }, [props.loaders, attempt]);

  const state = useMemo<KernelState>(() => {
    const sections = new Map<string, NavSection>();
    const nav: NavEntry[] = [];
    const routes: ClientRoute[] = [];
    const slotMap = new Map<string, SlotContribution[]>();
    const onboarding: OnboardingStep[] = [];
    const byOrder = <T extends { readonly order?: number }>(a: T, b: T): number => (a.order ?? 0) - (b.order ?? 0);
    for (const mod of modules) {
      for (const s of mod.sections ?? []) if (!sections.has(s.id)) sections.set(s.id, s);
      nav.push(...(mod.nav ?? []));
      routes.push(...(mod.routes ?? []));
      onboarding.push(...(mod.onboarding ?? []));
      for (const s of mod.slots ?? []) {
        const list = slotMap.get(s.slot) ?? [];
        list.push(s);
        slotMap.set(s.slot, list);
      }
    }
    // Sort each slot list ONCE here, so slots(name) is a cheap lookup per render.
    for (const list of slotMap.values()) list.sort(byOrder);
    return {
      descriptors,
      modules,
      ready,
      sections: [...sections.values()].sort((a, b) => a.order - b.order),
      nav: [...nav].sort(byOrder),
      routes: compileRoutes(routes),
      slots: (name) => slotMap.get(name) ?? [],
      onboarding: [...onboarding].sort((a, b) => a.order - b.order),
    };
  }, [descriptors, modules, ready]);

  if (!ready && error !== null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="text-lg font-semibold">Couldn&apos;t load the workspace</div>
        <p className="dim max-w-sm text-sm">{error}</p>
        <button
          className="btn"
          onClick={() => {
            setError(null);
            setAttempt((a) => a + 1);
          }}
        >
          Retry
        </button>
      </div>
    );
  }

  return <KernelContext.Provider value={state}>{props.children}</KernelContext.Provider>;
}

/**
 * Is an optional module enabled in THIS instance?
 *
 * The client half of the `tryGet` rule. A module may only call another module's
 * endpoints when that module is actually there, and "there" is per instance, not
 * per build: an optional module can be absent from the profile, present but not
 * installed, or installed and later disabled. All three look the same from a
 * fetch, which 404s with `no route`, and a stray 404 surfaces as an error banner
 * on a page that is otherwise fine.
 *
 * Use it to skip the request, not to hide the error afterwards.
 */
export function useModuleEnabled(id: string): boolean {
  const { descriptors } = useKernel();
  return descriptors.some((m) => m.id === id && m.enabled);
}

export function useKernel(): KernelState {
  const ctx = useContext(KernelContext);
  if (!ctx) throw new Error('useKernel outside <ModulesProvider>');
  return ctx;
}
