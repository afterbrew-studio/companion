/**
 * Per-module configuration — the isomorphic half. A module declares its config
 * as a DECLARATIVE field list on the manifest (not a zod schema): the spec is
 * pure data, so the kernel can serve it from `GET /api/modules` and the client
 * can render an install/configure form without loading any module code. The
 * server derives the actual zod validator from it (`/server` module-config-store).
 */

export type ModuleConfigValue = string | number | boolean;

export type ModuleConfigFieldKind = 'text' | 'secret' | 'number' | 'boolean' | 'select';

/**
 * One user-facing configuration field. The spec (including `default`) is visible
 * to every signed-in user via `GET /api/modules` — so a `secret` field must not
 * declare a `default` (enforced by the server-side schema derivation).
 */
export interface ModuleConfigField {
  readonly key: string;
  readonly label: string;
  readonly kind: ModuleConfigFieldKind;
  readonly description?: string;
  /** Must hold a value (or a `default`) before the module can be installed/enabled. */
  readonly required?: boolean;
  readonly default?: ModuleConfigValue;
  readonly placeholder?: string;
  /** `kind: 'select'` only — the allowed values. */
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  /** `kind: 'number'`: value bounds. `kind: 'text' | 'secret'`: length bounds. */
  readonly min?: number;
  readonly max?: number;
  /** `kind: 'text'` only — RegExp source the value must match. */
  readonly pattern?: string;
}

/**
 * The redacted wire shape of a module's stored config (`GET/PUT .../config`).
 * Secret keys NEVER appear in `values` — redaction by omission, same convention
 * as the Row→Record mappers — only their set/unset state crosses in `secrets`.
 */
export interface ModuleConfigState {
  /** Stored values for non-secret fields (no defaults merged — the client has the spec). */
  readonly values: Readonly<Record<string, ModuleConfigValue>>;
  /** For each `kind: 'secret'` field: whether a value is stored. Never the value. */
  readonly secrets: Readonly<Record<string, boolean>>;
}

/**
 * What a module reads its own config through (`ctx.moduleConfig`). Read-only and
 * live — each call hits the store, so an admin edit is visible on the next read.
 * Defaults from the spec are merged in; a required-but-unset field (possible when
 * an upgrade adds one to an already-enabled module) reads as `null` — tolerate it.
 */
export interface ModuleConfigAccessor {
  values(): Readonly<Record<string, ModuleConfigValue>>;
  get(key: string): ModuleConfigValue | null;
}
