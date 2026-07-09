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
