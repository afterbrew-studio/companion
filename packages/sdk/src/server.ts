/**
 * `@moxxy/companion-sdk/server` — the `/api` slice of a module.
 *
 * What is deliberately absent, and why: `ModuleKernel`, `DynamicRouter`,
 * `RawRouter`, `MigrationRunner`, `ServiceRegistry`, `ServerBus`, `RbacGrid`,
 * `WsHub`, `ModuleConfigStore` and the `Compiled*` route shapes are the host's
 * own machinery. A module receives what it needs from `ModuleContext`; reaching
 * past that couples it to internals that must stay free to change. `readBody` /
 * `readRawBody` are the HTTP edge, already applied before a handler runs.
 */

// ---- registrants: the six barrels a module's /api slice exports ----
export {
  defineApiModule,
  defineAcl,
  defineMigrations,
  defineServices,
  defineRoutes,
  defineRawRoutes,
  defineJobs,
} from '@companion/core/server';

export type {
  ServerModule,
  ModuleContext,
  ModuleListing,
  BackgroundJob,
  LifecycleHooks,
  ServiceFactory,
  RouteFactory,
  RawRouteFactory,
} from '@companion/core/server';

// ---- routing ----
export { route, Reply, created, accepted, document, redirect, bearerToken } from '@companion/core/server';
export { HttpError, notFound, badRequest, forbidden } from '@companion/core/server';
export type { RouteContext, RouteDef, HttpMethod, PathParams, StatusError } from '@companion/core/server';

/** Byte-body, self-authenticating endpoints (webhooks): outside the JSON router and RBAC. */
export { rawRoute } from '@companion/core/server';
export type { RawRouteContext, RawRouteDef, RawReply } from '@companion/core/server';

// ---- persistence ----
export type { Migration, MigrationEnv } from '@companion/core/server';

// ---- capabilities a module consumes, or provides ----
export type {
  AuditEvent,
  AuditSink,
  SecretStore,
  SettingsRegistry,
  NotificationEmitter,
  NotificationInput,
  BaseNotificationKind,
} from '@companion/core/server';

/**
 * @deprecated The pre-registry notification shape. Present so modules still on
 * it compile against the SDK; use `ctx.notify.emit` in new code.
 */
export { legacyNotifications } from '@companion/core/server';

// ---- RBAC: read side only. Modules declare grants in acl.ts, never mutate the grid. ----
export type {
  RbacReader,
  AclSource,
  PermissionEntry,
  AclExplanation,
  RoleOverride,
  RoleOverrides,
} from '@companion/core/server';

// ---- WS scoping: which sockets a broadcast reaches ----
export type { MessageScope, ScopeResolver } from '@companion/core/server';

// ---- host services a module legitimately touches ----
export { paths, likeArg, safeParse, currentUser, log } from '@companion/services';
export type { DaemonConfig, Logger } from '@companion/services';
