import type Database from 'better-sqlite3';
import type { Authenticator, ModuleAcl, SpaServerMessage } from '@companion/contracts';
import type { DaemonConfig, Logger } from '@companion/services';
import type { ModuleManifest } from '../manifest.js';
import type { CompiledRoute } from './router.js';
import type { Migration } from './migration-runner.js';
import type { ServiceRegistry } from './service-registry.js';
import type { ServerBus } from './bus.js';
import type { NotificationEmitter, SettingsRegistry } from './capabilities.js';
import type { RbacReader } from './rbac-grid.js';

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
  readonly settings: SettingsRegistry;
  /** The live effective RBAC grid (module-core's Auth reads this). */
  readonly rbac: RbacReader;
  readonly isEnabled: (moduleId: string) => boolean;
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

/** The `/api` barrel of a module — its whole server surface. */
export interface ServerModule {
  readonly manifest: ModuleManifest;
  readonly acl?: ModuleAcl;
  readonly migrations?: readonly Migration[];
  /** Construct services + `ctx.services.register(id, instance)`. Runs (awaited) in topo order. */
  readonly registerServices?: ServiceFactory;
  readonly routes?: RouteFactory;
  readonly lifecycle?: LifecycleHooks;
  /** module-core only: the authenticator the kernel wires into the router. */
  readonly provideAuthenticator?: (ctx: ModuleContext) => Authenticator;
  /** Destructive uninstall for modules whose migrations are not all reversible. */
  purge?(db: Database.Database): void;
}

// ---- registrants: identity fns typed to their interface (authoring-site DX) ----
export const defineAcl = (a: ModuleAcl): ModuleAcl => a;
export const defineMigrations = (m: readonly Migration[]): readonly Migration[] => m;
export const defineServices = (f: ServiceFactory): ServiceFactory => f;
export const defineRoutes = (f: RouteFactory): RouteFactory => f;
export const defineJobs = (h: LifecycleHooks): LifecycleHooks => h;
export const defineApiModule = (m: ServerModule): ServerModule => m;
