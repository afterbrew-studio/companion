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
} from '@moxxy/companion-core/server';

export type {
  ServerModule,
  ModuleContext,
  ModuleListing,
  BackgroundJob,
  LifecycleHooks,
  ServiceFactory,
  RouteFactory,
  RawRouteFactory,
} from '@moxxy/companion-core/server';

// ---- routing ----
export { route, Reply, created, accepted, document, redirect, bearerToken } from '@moxxy/companion-core/server';
export { HttpError, notFound, badRequest, forbidden } from '@moxxy/companion-core/server';
export type { RouteContext, RouteDef, HttpMethod, PathParams, StatusError } from '@moxxy/companion-core/server';

/** Byte-body, self-authenticating endpoints (webhooks): outside the JSON router and RBAC. */
export { rawRoute } from '@moxxy/companion-core/server';
export type { RawRouteContext, RawRouteDef, RawReply } from '@moxxy/companion-core/server';

// ---- persistence ----
export type { Migration, MigrationEnv } from '@moxxy/companion-core/server';

/**
 * The handle `ctx.db` is, and the statements it prepares. Types only: a module's
 * store is handed the daemon's connection and must never open a second one.
 */
export type { Database, Statement, RunResult } from '@moxxy/companion-services';

// ---- capabilities a module consumes, or provides ----
export type {
  AuditEvent,
  AuditSink,
  SecretStore,
  SettingsRegistry,
  NotificationEmitter,
  NotificationInput,
  BaseNotificationKind,
} from '@moxxy/companion-core/server';

/**
 * @deprecated The pre-registry notification shape. Present so modules still on
 * it compile against the SDK; use `ctx.notify.emit` in new code.
 */
export { legacyNotifications } from '@moxxy/companion-core/server';

// ---- RBAC: read side only. Modules declare grants in acl.ts, never mutate the grid. ----
export type {
  RbacReader,
  AclSource,
  PermissionEntry,
  AclExplanation,
  RoleOverride,
  RoleOverrides,
} from '@moxxy/companion-core/server';

// ---- WS scoping: which sockets a broadcast reaches ----
export type { MessageScope, ScopeResolver } from '@moxxy/companion-core/server';

// ---- host services a module legitimately touches ----
export { paths, likeArg, safeParse, currentUser, log } from '@moxxy/companion-services';
export type { DaemonConfig, Logger } from '@moxxy/companion-services';

// ---- open integration-provider ABI ------------------------------------------
export { IntegrationUnavailableError, NOTIFICATION_KIND_OPTIONS } from './integrations.js';
export type {
  EffectiveIntegrationRoute,
  IntegrationNotificationKind,
  IntegrationCapability,
  IntegrationCatalog,
  IntegrationCategory,
  IntegrationConfigField,
  IntegrationCommandOptions,
  IntegrationCommandResult,
  IntegrationCommandRunner,
  IntegrationConnectionAccess,
  IntegrationConnectionDraft,
  IntegrationConnectionRecord,
  IntegrationDeliveryResult,
  IntegrationExecutor,
  IntegrationExecutorResolver,
  IntegrationFieldOption,
  IntegrationFieldValue,
  IntegrationHealth,
  IntegrationHealthStatus,
  IntegrationHost,
  IntegrationNotificationInput,
  IntegrationProviderAdapter,
  IntegrationProviderDescriptor,
  IntegrationProbeContext,
  IntegrationProviderRegistry,
  IntegrationReviewFinding,
  IntegrationReviewRequest,
  IntegrationReviewResult,
  IntegrationRouteRecord,
  IntegrationScope,
  IntegrationTargetRef,
  ResolvedIntegrationTarget,
} from './integrations.js';
