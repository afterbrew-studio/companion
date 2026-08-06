/**
 * The module metafile — a pure-data descriptor with ZERO heavy imports (no
 * routes, services or pages). Compiled to `dist/module.js` and exported as
 * `@companion/module-<id>/manifest`, so `GET /api/modules` and the dependency
 * graph resolve without importing any module's code.
 */
import type { ModuleConfigField } from './module-config.js';

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
  /**
   * Permission ids owned by ANOTHER module that this one deliberately gates on
   * without a `dependsOn` edge, so the coupling is declared rather than merely
   * present. Only for uses that tolerate the owner being disabled: the
   * permission leaves the grid with its module, so `can()` goes false and the
   * UI must degrade. If absence is not tolerable, use `dependsOn` instead.
   */
  readonly consumes?: readonly string[];
  /** WS message tags this module owns (documentation / conflict detection). */
  readonly messages?: readonly string[];
  /**
   * User-facing configuration fields (declarative — see module-config.ts). The
   * kernel validates values against this spec and gates install/enable on the
   * `required` ones; modules read values via `ctx.moduleConfig`.
   */
  readonly config?: readonly ModuleConfigField[];
  /**
   * Entitlement id this module needs. The kernel refuses to install or enable it
   * without a licence granting the feature, and disables it at boot if the
   * licence lapses. Absent on every OSS module: an unentitled module is simply
   * never gated.
   */
  readonly entitlement?: string;
  /**
   * `false` ⇒ a newly compiled-in module lands as "Available" (installed=0)
   * instead of auto-installing at boot. Ignored for `required` modules. A module
   * with required config fields lacking defaults never auto-installs either.
   */
  readonly autoInstall?: boolean;
}

export const defineManifest = (m: ModuleManifest): ModuleManifest => m;
