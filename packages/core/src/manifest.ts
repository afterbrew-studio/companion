/**
 * The module metafile — a pure-data descriptor with ZERO heavy imports (no
 * routes, services or pages). Compiled to `dist/module.js` and exported as
 * `@companion/module-<id>/manifest`, so `GET /api/modules` and the dependency
 * graph resolve without importing any module's code.
 */
import type { ModuleConfigField } from './module-config.js';

/** The instance version reported to clients (WS hello + /api/auth/state). One source. */
export const APP_VERSION = '0.3.0';

export type ModuleId = string;

export interface ModuleManifest {
  readonly id: ModuleId;
  readonly title: string;
  readonly version: string;
  /** Module ids that must be enabled before this one. */
  readonly dependsOn?: readonly ModuleId[];
  /** Cannot be disabled (identity + the workspace scoping key). */
  readonly required?: boolean;
  /** Permission ids this module owns (documentation / GET /api/modules). */
  readonly permissions?: readonly string[];
  /** WS message tags this module owns (documentation / conflict detection). */
  readonly messages?: readonly string[];
  /**
   * User-facing configuration fields (declarative — see module-config.ts). The
   * kernel validates values against this spec and gates install/enable on the
   * `required` ones; modules read values via `ctx.moduleConfig`.
   */
  readonly config?: readonly ModuleConfigField[];
  /**
   * `false` ⇒ a newly compiled-in module lands as "Available" (installed=0)
   * instead of auto-installing at boot. Ignored for `required` modules. A module
   * with required config fields lacking defaults never auto-installs either.
   */
  readonly autoInstall?: boolean;
}

export const defineManifest = (m: ModuleManifest): ModuleManifest => m;
