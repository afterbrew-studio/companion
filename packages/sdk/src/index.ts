/**
 * `@moxxy/companion-sdk` — everything a Companion module is authored against.
 *
 * This package is a **curated façade**, not a re-export of the workspace. The
 * distinction is the point: `@companion/core/server` also exports the kernel,
 * the dynamic router, the migration runner and the service registry, which are
 * the host's own machinery. A module that reached for them would be coupled to
 * an implementation that has to stay free to change. So the surface here is an
 * explicit list, and `scripts/sdk-surface.mjs` fails the build when it drifts
 * from the committed snapshot: widening a permanent ABI should be a decision
 * someone made, not a line that slipped into a barrel.
 *
 * Entry points:
 *   `.`         this file — the metafile a module's `module.ts` is written with
 *   `/server`   the `/api` slice: routes, services, migrations, acl, jobs
 *   `/client`   the `/client` slice: nav, routes, slots, onboarding, hooks
 *   `/ui`       the component library the client slice renders with
 *   `/agents`   the agent-run types, for modules that compose runs
 *
 * ## The one import that is NOT from here
 *
 * A module's `contract/` slice augments the open registries:
 *
 * ```ts
 * declare module '@moxxy/companion-contracts' {
 *   interface PermissionRegistry { 'widgets:manage': true }
 * }
 * ```
 *
 * That specifier cannot be replaced by an SDK one. TypeScript binds declaration
 * merging to the module that DECLARES the interface; augmenting a package that
 * merely re-exports it silently creates a second, unrelated interface (measured:
 * TS2820, the augmented key is rejected as not assignable). Hiding the real
 * target behind a façade would produce an ABI whose permissions quietly fail to
 * register, which is worse than one extra package name. So `@moxxy/companion-contracts`
 * is part of the public ABI and a module depends on both.
 */

/**
 * This package's own version, and the ABI generation an out-of-tree module
 * declares as `moxxy.abi` in its package.json. The daemon refuses a module built
 * against a different generation at boot, which is where a mismatch is cheap.
 */
export const SDK_VERSION = '0.1.0'; // keep in step with package.json (checked by pnpm sdk:surface)
export const ABI_GENERATION = '0.x';

export { defineManifest, APP_VERSION } from '@companion/core';
export type { ModuleManifest, ModuleId } from '@companion/core';
export type {
  ModuleConfigField,
  ModuleConfigFieldKind,
  ModuleConfigValue,
  ModuleConfigAccessor,
  ModuleConfigState,
} from '@companion/core';

/** The cross-boundary spine. Augment the registries via `@moxxy/companion-contracts`. */
export type {
  Permission,
  PermissionRegistry,
  ServerMessageRegistry,
  ServiceMap,
  BusEvents,
  SpaServerMessage,
  AuthUser,
} from '@moxxy/companion-contracts';

export { BUILTIN_ROLES, isBuiltinRole } from '@companion/types';
export type { Role, BuiltinRole } from '@companion/types';
