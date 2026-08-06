import { randomUUID } from 'node:crypto';
import type { ServiceMap, SpaServerMessage } from '@moxxy/companion-contracts';
import { log } from '@moxxy/companion-sdk/server';
import type { IntegrationScope } from '@companion/module-integrations/contract';
import type {
  IntegrationNotificationInput,
  ResolvedIntegrationTarget,
} from '@companion/module-integrations/provider';
import type { NotificationRecord } from '@companion/module-workspace/contract';
import type { NotifyDeliveryRecord } from '../contract/index.js';
import type { NotifyStore } from './notify-store.js';

/**
 * Provider-neutral outbound delivery of the durable Companion inbox.
 *
 * Connections, credentials, ownership and scope all belong to the Integrations
 * plane. Notify subscribes once, fans out to matching notification providers
 * and owns only the bounded operational delivery history.
 */
export class NotifyService {
  constructor(
    private readonly store: NotifyStore,
    private readonly integrations: ServiceMap['integrations'],
    private readonly publicUrl: () => string | null,
    private readonly broadcast: (msg: SpaServerMessage) => void,
  ) {}

  deliveriesFor(
    userId: string | null,
    scopes: readonly IntegrationScope[] = [{ kind: 'instance' }],
    limit?: number,
  ): NotifyDeliveryRecord[] {
    return this.store.deliveriesForScopes(scopes, userId, limit);
  }

  /** Deliver one inbox event concurrently to every matching provider. */
  async fanOut(notification: NotificationRecord): Promise<void> {
    const input = integrationNotification(notification, this.publicUrl());
    const scope = notification.repo && notification.workspaceId
      ? { kind: 'repository' as const, workspaceId: notification.workspaceId, repo: notification.repo }
      : notification.workspaceId
        ? { kind: 'workspace' as const, workspaceId: notification.workspaceId }
        : { kind: 'instance' as const };
    const targets = this.integrations
      .matchingConnections('notifications', scope, notification.userId)
      .filter((target) => {
        if (!target.connection) return false;
        try {
          return target.provider.acceptsNotification?.(target.connection, input) ?? true;
        } catch (error) {
          log.warn('integration notification filter failed', {
            providerId: target.provider.descriptor.id,
            err: String(error instanceof Error ? error.message : error),
          });
          return false;
        }
    });
    if (targets.length === 0) return;
    // Connections are operator-created and therefore unbounded. Keep one busy
    // workspace from opening hundreds of sockets at once.
    for (let offset = 0; offset < targets.length; offset += 8) {
      await Promise.all(targets.slice(offset, offset + 8).map((target) => this.send(target, input)));
    }
    this.broadcast({ t: 'notify.changed' });
  }

  pruneHistory(): void {
    if (this.store.prune() > 0) this.broadcast({ t: 'notify.changed' });
  }

  private async send(
    target: ResolvedIntegrationTarget,
    notification: IntegrationNotificationInput,
  ): Promise<void> {
    const connection = target.connection;
    if (!connection) return;
    let outcome;
    try {
      outcome = await this.integrations.deliverNotification(target, notification);
    } catch (error) {
      outcome = {
        ok: false,
        httpStatus: null,
        error: String(error instanceof Error ? error.message : error).slice(0, 1_000),
        attempts: 0,
      };
    }
    this.store.logDelivery(
      {
        id: `nd-${randomUUID().slice(0, 12)}`,
        connectionId: connection.record.id,
        providerId: target.provider.descriptor.id,
        connectionName: connection.record.name,
        title: notification.title,
        status: outcome.ok ? 'delivered' : 'failed',
        httpStatus: outcome.httpStatus,
        error: outcome.error,
        attempts: outcome.attempts,
        createdAt: Date.now(),
      },
      connection.record.scope,
      connection.record.ownerId,
    );
    if (!outcome.ok) {
      log.warn('integration notification failed', {
        connection: connection.record.name,
        providerId: target.provider.descriptor.id,
        err: outcome.error,
      });
    }
  }
}

function integrationNotification(
  notification: NotificationRecord,
  publicUrl: string | null,
): IntegrationNotificationInput {
  const url = notification.href && publicUrl
    ? `${publicUrl.replace(/\/+$/, '')}/${notification.href.replace(/^\/+/, '')}`
    : null;
  return {
    id: notification.id,
    kind: notification.kind,
    title: notification.title,
    body: notification.body,
    workspaceId: notification.workspaceId,
    repo: notification.repo,
    href: notification.href,
    url,
    createdAt: notification.createdAt,
  };
}
