import type Database from 'better-sqlite3';
import type { Authenticator, ModuleAcl, SpaServerMessage } from '@moxxy/companion-contracts';
import type { DaemonConfig, Logger } from '@moxxy/companion-services';
import type { ModuleManifest, ModuleId } from '../manifest.js';
import type { ModuleConfigAccessor, ModuleConfigField, ModuleConfigState } from '../module-config.js';
import type { CompiledRoute } from './router.js';
import type { CompiledRawRoute } from './raw-router.js';
import type { Migration } from './migration-runner.js';
import type { ServiceRegistry } from './service-registry.js';
import type { ServerBus } from './bus.js';
import type { AuditSink, NotificationEmitter, SecretStore, SettingsRegistry } from './capabilities.js';
import type { RbacReader, RoleOverrides } from './rbac-grid.js';
import type { WsScopeRegistry } from './ws-hub.js';

/**
 * What every server-side module factory receives — replaces the flat `ApiDeps`
 * god-object. Cross-module access is through the typed `services` registry;
 * cross-module reactions through `bus`; browser push through `broadcast`.
 */
export interface ModuleContext {
  readonly db: Database.Database;
  readonly log: Logger;
  readonly config: DaemonConfig;
  /** SQLite FTS5 availability (probed once at bootstrap) — search features degrade without it. */
  readonly fts: { readonly available: boolean };
  readonly services: ServiceRegistry;
  readonly bus: ServerBus;
  readonly broadcast: (msg: SpaServerMessage) => void;
  readonly pushToUser: (username: string, msg: SpaServerMessage) => void;
  readonly notify: NotificationEmitter;
  /** Record an action for the audit trail. The router covers routes; use this
   *  for a decision a service makes that no single route describes. */
  readonly audit: AuditSink;
  readonly settings: SettingsRegistry;
  /** This module's own declared config — read-only, live, defaults merged. */
  readonly moduleConfig: ModuleConfigAccessor;
  /** The live effective RBAC grid (module-core's Auth reads this). */
  readonly rbac: RbacReader;
  /**
   * Publish this instance's role definitions and grant overrides into the live
   * grid. Owned by whichever module STORES roles (module-core); everyone else
   * reads through `rbac`. Kept off `RbacReader` so that interface stays honest
   * about being read-only.
   */
  readonly setRoles: (overrides: RoleOverrides) => void;
  /** Per-message WS visibility: modules register scope resolvers in onEnable. */
  readonly ws: WsScopeRegistry;
  /** Kernel lifecycle control — module-core's Modules admin surface drives this. */
  readonly modules: KernelControl;
  readonly isEnabled: (moduleId: string) => boolean;
}

/** The runtime toggle surface the kernel exposes to modules (via ctx.modules). */
export interface KernelControl {
  list(): readonly ModuleListing[];
  /** Validate + persist `config`, then activate. The only path from "Available" to installed. */
  install(id: ModuleId, config?: Readonly<Record<string, unknown>>): Promise<void>;
  enable(id: ModuleId): Promise<void>;
  disable(id: ModuleId): Promise<void>;
  uninstall(id: ModuleId): Promise<void>;
  /** Stored config, redacted — secret values never leave the kernel. */
  getConfig(id: ModuleId): ModuleConfigState;
  /** Validated partial update: omitted key = unchanged, `null` = clear, secrets reject `''`. */
  setConfig(id: ModuleId, patch: Readonly<Record<string, unknown>>): void;
}

/** One catalog module for GET /api/modules (manifest + live state; no code loaded). */
export interface ModuleListing {
  readonly id: ModuleId;
  readonly title: string;
  readonly version: string;
  readonly dependsOn: readonly ModuleId[];
  readonly required: boolean;
  /** false ⇒ "Available": in the compiled catalog but not adopted (no tables, no routes). */
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
  /** Out-of-tree module whose client chunk the shell must fetch from
   *  `/modules/<id>/client.js` instead of a compiled-in loader. */
  readonly externalClient: boolean;
}

export interface BackgroundJob {
  readonly id: string;
  readonly everyMs: number;
  run(ctx: ModuleContext): Promise<void> | void;
}

export interface LifecycleHooks {
  onEnable?(ctx: ModuleContext): void | Promise<void>;
  onDisable?(ctx: ModuleContext): void | Promise<void>;
  /** Resumers / recovery — run once after ALL enabled modules' `onEnable`. */
  postActivate?(ctx: ModuleContext): void | Promise<void>;
  readonly jobs?: readonly BackgroundJob[];
}

export type ServiceFactory = (ctx: ModuleContext) => void | Promise<void>;
export type RouteFactory = (ctx: ModuleContext) => readonly CompiledRoute[];
export type RawRouteFactory = (ctx: ModuleContext) => readonly CompiledRawRoute[];

/** The `/api` barrel of a module — its whole server surface. */
export interface ServerModule {
  readonly manifest: ModuleManifest;
  readonly acl?: ModuleAcl;
  readonly migrations?: readonly Migration[];
  /** Construct services + `ctx.services.register(id, instance)`. Runs (awaited) in topo order. */
  readonly registerServices?: ServiceFactory;
  readonly routes?: RouteFactory;
  /** Byte-body, self-authenticating endpoints (webhooks) — outside the JSON router + RBAC. */
  readonly rawRoutes?: RawRouteFactory;
  readonly lifecycle?: LifecycleHooks;
  /** module-core only: the authenticator the kernel wires into the router. */
  readonly provideAuthenticator?: (ctx: ModuleContext) => Authenticator;
  /** The audit sink the router writes through. Last enabled provider wins, so a
   *  dedicated audit module can take over from module-core's minimal table. */
  readonly provideAudit?: (ctx: ModuleContext) => AuditSink;
  /** Storage for `kind: 'secret'` config. Absent everywhere = the SQLite default;
   *  last enabled provider wins and inherits the values already stored. */
  readonly provideSecrets?: (ctx: ModuleContext) => SecretStore;
  /** Destructive uninstall for modules whose migrations are not all reversible. */
  purge?(db: Database.Database): void;
}

// ---- registrants: identity fns typed to their interface (authoring-site DX) ----
export const defineAcl = (a: ModuleAcl): ModuleAcl => a;
export const defineMigrations = (m: readonly Migration[]): readonly Migration[] => m;
export const defineServices = (f: ServiceFactory): ServiceFactory => f;
export const defineRoutes = (f: RouteFactory): RouteFactory => f;
export const defineRawRoutes = (f: RawRouteFactory): RawRouteFactory => f;
export const defineJobs = (h: LifecycleHooks): LifecycleHooks => h;
export const defineApiModule = (m: ServerModule): ServerModule => m;
