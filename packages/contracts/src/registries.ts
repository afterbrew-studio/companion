/**
 * Open, declaration-merged registries. Each compiled-in module augments these
 * interfaces from its own `contract/` slice, so the derived unions
 * (`Permission`, `SpaServerMessage`) are exactly the set of INSTALLED modules —
 * no codegen. The kernel declares only the framework-level base members here.
 */

/** Capability keys. Modules augment: `interface PermissionRegistry { 'plan:read': true }`. */
export interface PermissionRegistry {}
export type Permission = keyof PermissionRegistry & string;

/** UI directives the server can push to one user's browser(s). */
export type ClientIntent = 'new-workspace' | 'connect-repo' | 'connect-github';

/**
 * Server→browser WebSocket messages keyed by the `t` discriminator; the value
 * is the rest of the message body. Modules augment with their domain events:
 * `interface ServerMessageRegistry { 'plan.changed': {} }`.
 */
export interface ServerMessageRegistry {
  readonly hello: { readonly version: string };
  readonly 'modules.changed': Record<never, never>;
  readonly 'client.intent': { readonly hash?: string; readonly intent?: ClientIntent };
}
export type SpaServerMessage = {
  readonly [K in keyof ServerMessageRegistry]: { readonly t: K } & ServerMessageRegistry[K];
}[keyof ServerMessageRegistry];

/**
 * Typed cross-module service locator. Modules augment with the service they
 * provide: `interface ServiceMap { plan: PlanService }`. Presence is
 * runtime-checked (a disabled module's key is absent) — always resolve across a
 * declared `dependsOn` edge, or use `tryGet` for a soft dependency.
 */
export interface ServiceMap {}

/**
 * Server-internal typed event bus (distinct from browser `broadcast`). Modules
 * augment with their event payloads: `interface BusEvents { 'run.changed': RunRecord }`.
 */
export interface BusEvents {}
