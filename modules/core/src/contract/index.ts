/**
 * module-core contract slice. The `declare module` augmentations open the shared
 * registries with this module's capabilities and WS events — visible wherever a
 * build imports this module, keeping `Permission`/`SpaServerMessage` exhaustive.
 */

declare module '@companion/contracts' {
  interface PermissionRegistry {
    'users:manage': true;
    'settings:manage': true;
  }
  interface ServerMessageRegistry {
    'notifications.changed': Record<never, never>;
  }
}

export type NotificationKind = 'action_required' | 'finished' | 'error' | 'info';

export interface NotificationRecord {
  readonly id: string;
  /** Workspace the event belongs to; null = instance-wide. */
  readonly workspaceId: string | null;
  readonly kind: NotificationKind;
  readonly title: string;
  readonly body: string;
  readonly href: string | null;
  readonly readAt: number | null;
  readonly createdAt: number;
}

// Ensure this file is a module (augmentations require at least one export/import).
export {};
