import type { SpaServerMessage } from '@moxxy/companion-contracts';

/** The base notification kinds the framework knows; modules may add more meaning client-side. */
export type BaseNotificationKind = 'action_required' | 'finished' | 'error' | 'info';

export interface NotificationInput {
  readonly kind: BaseNotificationKind;
  /** Workspace the event belongs to; null = instance-wide. */
  readonly workspaceId: string | null;
  /** Repository whose cached/activity data the notification exposes. */
  readonly repo?: string | null;
  readonly title: string;
  readonly body?: string;
  readonly href?: string | null;
  /**
   * Whom this concerns. Omit for an event the whole workspace should see, which
   * is the default and covers every instance-wide alert. Naming someone narrows
   * the inbox to them and is what an outbound personal channel matches on.
   */
  readonly userId?: string | null;
}

/**
 * Shared notification emitter (provided by module-core). Replaces the duplicated
 * `insert + broadcast` sites: `ctx.notify.emit({...})`.
 */
export interface NotificationEmitter {
  emit(n: NotificationInput): void;
}

/** The legacy `store.notifications.insert({...})` shape — id/createdAt were once
 *  caller-supplied; the emitter now mints them, so those fields are ignored. */
export interface LegacyNotificationInput {
  id?: string;
  workspaceId: string | null;
  repo?: string | null;
  kind: BaseNotificationKind;
  title: string;
  body?: string;
  href?: string | null;
  createdAt?: number;
}

/**
 * Adapter that lets stores keep the pre-kernel `notifications.insert({...})`
 * call shape while routing through the shared emitter. One definition instead
 * of the same four-field forward copied into every module's store.
 *
 * The emitter is passed as a thunk because stores wire this as a class-field
 * initializer (`readonly notifications = legacyNotifications(() => this.notify)`)
 * — field initializers run before the constructor body assigns `this.notify`,
 * so the emitter must be read lazily, at `insert` time.
 */
export function legacyNotifications(emitter: () => NotificationEmitter): { insert(n: LegacyNotificationInput): void } {
  return {
    insert: (n) =>
      emitter().emit({
        kind: n.kind,
        workspaceId: n.workspaceId,
        repo: n.repo,
        title: n.title,
        body: n.body,
        href: n.href,
      }),
  };
}

/**
 * Namespaced key/value settings over the core-owned `settings` table (provided
 * by module-core). Modules read/write their own keys.
 */
export interface SettingsRegistry {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

/** Browser push surface (backed by the app's WebSocket hub). */
export interface Broadcaster {
  broadcast(msg: SpaServerMessage): void;
  pushToUser(username: string, msg: SpaServerMessage): void;
}

/**
 * One recorded action. The router emits these for every MUTATING request that
 * got past authorization, which is what makes coverage near-complete for free:
 * every route already declares `access`, so there is exactly one place to hook.
 * Reads are deliberately not recorded, because they would bury the writes.
 */
export interface AuditEvent {
  readonly at: number;
  /** null only for a `public` route (setup, a rejected login). */
  readonly actor: string | null;
  /** `POST /api/modules/:id/enable`: the route PATTERN, not the concrete path,
   *  so the table groups by action instead of by id. */
  readonly action: string;
  /** The permission the route required, or `any` / `public`. */
  readonly access: string;
  readonly status: number;
  /** Module the route belongs to; null for framework-level entries. */
  readonly module: string | null;
  /** Free-form detail for events a service emits that no single route describes. */
  readonly detail?: string;
  /** Client address as the router derived it (trust-proxy aware); absent for
   *  events emitted outside a request (jobs, boot). */
  readonly ip?: string;
  /** The request's User-Agent header, bounded; absent outside a request. */
  readonly agent?: string;
}

/**
 * Where audit events go. Provided by the module that owns the audit table
 * (module-core today). An absent provider makes auditing a silent no-op rather
 * than a boot failure: an instance must still serve requests.
 */
export interface AuditSink {
  record(event: AuditEvent): void;
}

/**
 * Where `kind: 'secret'` module config actually lives.
 *
 * Companion stores secrets in its own SQLite home by default, which is the right
 * default for a self-hosted appliance: one file to back up, one file to protect,
 * no extra service to run. It is the wrong default for an organisation that has
 * already decided secrets live in Vault, AWS Secrets Manager or a KMS-wrapped
 * store and audits them there. So the storage is a seam, not a fact.
 *
 * A module takes it over with `provideSecrets` (the same shape as `provideAudit`).
 * The kernel then moves any values already held by the previous store into the
 * new one and deletes the originals, so swapping the backend does not silently
 * un-configure every module. The provider's OWN secrets stay in the default
 * store, because it needs them to reach the backend it is about to become.
 *
 * Non-secret config is unaffected: it stays in SQLite regardless.
 */
/**
 * A module's own secret storage for values whose keys it invents at run time,
 * rather than declaring them in its manifest.
 *
 * Manifest `kind: 'secret'` config covers the fixed case (one npm token, one
 * SMTP password). This covers the open one: a user adding a hidden variable to
 * a pipeline step is naming a secret the manifest could never have anticipated.
 *
 * Scoped to the calling module and backed by the same `SecretStore` seam, so an
 * instance that moved secrets to Vault keeps these there too. Values are
 * redacted from `ModuleConfigState` exactly like declared ones.
 */
export interface ModuleSecrets {
  /** `null` when unset. */
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
  /** Which keys hold a value. Never the values. */
  keys(): readonly string[];
}

export interface SecretStore {
  /** `null` when unset. */
  get(moduleId: string, key: string): string | null;
  set(moduleId: string, key: string, value: string): void;
  delete(moduleId: string, key: string): void;
  /** Which keys hold a value, for the configured-ness check that must not read them. */
  keys(moduleId: string): readonly string[];
  /** Uninstall's clean slate. */
  deleteAll(moduleId: string): void;
}
