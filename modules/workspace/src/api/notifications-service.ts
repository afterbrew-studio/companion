import { randomUUID } from 'node:crypto';
import type { SpaServerMessage } from '@moxxy/companion-contracts';
import type { NotificationEmitter, NotificationInput } from '@moxxy/companion-sdk/server';
import type { NotificationRecord } from '../contract/index.js';
import type { NotificationsStore } from './notifications-store.js';

/**
 * The notification inbox service. Implements the kernel's `NotificationEmitter`
 * (`ctx.notify.emit(...)`) so any module can raise an inbox entry without owning
 * the table — `emit` mints the id/timestamp, persists, and pushes the live
 * `notifications.changed` signal. Also exposes the read side the inbox routes
 * use. Registered under `'notifications'`, which is what the kernel's `ctx.notify`
 * proxy (`services.raw('notifications')`) resolves to.
 */
export class NotificationsService implements NotificationEmitter {
  constructor(
    private readonly store: NotificationsStore,
    private readonly broadcast: (msg: SpaServerMessage) => void,
  ) {}

  emit(input: NotificationInput): void {
    this.store.insert({
      id: randomUUID(),
      workspaceId: input.workspaceId,
      repo: input.repo ?? null,
      kind: input.kind,
      title: input.title,
      body: input.body ?? '',
      href: input.href ?? null,
      createdAt: Date.now(),
    });
    this.broadcast({ t: 'notifications.changed' });
  }

  list(
    workspaceId: string | null | undefined,
    limit = 100,
    accessibleIds?: readonly string[],
  ): NotificationRecord[] {
    return this.store.list(workspaceId, limit, accessibleIds);
  }

  markRead(id: string): void {
    this.store.markRead(id);
  }

  markAllRead(workspaceId: string | null | undefined, accessibleIds?: readonly string[]): void {
    this.store.markAllRead(workspaceId, accessibleIds);
  }
}
