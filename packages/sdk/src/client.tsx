/**
 * `@moxxy-ai/companion-sdk/client` — the `/client` slice of a module.
 *
 * Source-only, like `@companion/core/client` and `@companion/ui`: the web host
 * resolves it through Vite's `source` condition and compiles it with the app, so
 * each module page stays its own lazy chunk. There is no `dist` here to import.
 *
 * Absent on purpose: `ModulesProvider`, `compileRoutes` / `matchRoute`,
 * `connectWs` / `disconnectWs`, `setToken` / `emitAuthChanged` / `refreshAuth`
 * and `passesFreshFilters`. Those are the shell: the socket lifecycle, the route
 * compiler, and the auth transitions module-core owns. A feature module reads
 * state and contributes registrations; it does not drive the host.
 */

// ---- registrants ----
export {
  defineClientModule,
  defineSections,
  defineNav,
  defineClientRoutes,
  defineSlots,
  defineOnboarding,
} from '@companion/core/client';

export type {
  WebModule,
  NavSection,
  NavEntry,
  SectionId,
  ClientRoute,
  RouteMatch,
  RouteProps,
  SlotContribution,
  OnboardingStep,
} from '@companion/core/client';

// ---- rendering helpers ----
export { OnboardingArt, NavIcon, Slot, lazyView, page } from '@companion/core/client';

// ---- the HTTP edge: authenticated by the host, so a module never handles tokens ----
export { request, post, put, patch, del, publicPost, qs, getToken, ApiError } from '@companion/core/client';
export type { PageQuery } from '@companion/core/client';

// ---- live state ----
export { useLive, isMessage, onServerMessage, onWsState, registerFreshFilter } from '@companion/core/client';
export type { WsState, FreshFilter } from '@companion/core/client';

// ---- host state a module reads ----
export { useKernel, useModuleEnabled } from '@companion/core/client';
export type { ModuleDescriptor } from '@companion/core/client';

// ---- cross-module affordances ----
export { useIntent, runIntent, requestIntent, useBulkRunner } from '@companion/core/client';
export type { Intent, BulkRunner } from '@companion/core/client';
export { runHref, pipelineRunHref, reportHref } from '@companion/core/client';
