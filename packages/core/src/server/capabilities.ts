import type { SpaServerMessage } from '@companion/contracts';

/** The base notification kinds the framework knows; modules may add more meaning client-side. */
export type BaseNotificationKind = 'action_required' | 'finished' | 'error' | 'info';

export interface NotificationInput {
  readonly kind: BaseNotificationKind;
  /** Workspace the event belongs to; null = instance-wide. */
  readonly workspaceId: string | null;
  readonly title: string;
  readonly body?: string;
  readonly href?: string | null;
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
    insert: (n) => emitter().emit({ kind: n.kind, workspaceId: n.workspaceId, title: n.title, body: n.body, href: n.href }),
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
