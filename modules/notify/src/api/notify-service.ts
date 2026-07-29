import { randomUUID } from 'node:crypto';
import type { SpaServerMessage } from '@moxxy/companion-contracts';
import { log } from '@moxxy/companion-sdk/server';
import type { NotificationRecord } from '@companion/module-workspace/contract';
import type {
  NotifyChannelDraft,
  NotifyChannelRecord,
  NotifyDeliveryRecord,
  NotifyTestResult,
} from '../contract/index.js';
import type { ChannelTarget, NotifyStore } from './notify-store.js';
import { buildRequest, deliver } from './delivery.js';

/**
 * Outbound delivery of the inbox.
 *
 * `fanOut` is called from the `notification.raised` bus subscription and is
 * deliberately fire-and-forget: the inbox row is already durable, so a
 * destination being down must not surface as a failure of whatever raised the
 * notification. Every outcome is recorded on the channel and in a bounded log,
 * because a channel that silently stopped working is the failure mode that
 * matters here.
 */
export class NotifyService {
  constructor(
    private readonly store: NotifyStore,
    private readonly publicUrl: () => string | null,
    private readonly broadcast: (msg: SpaServerMessage) => void,
  ) {}

  // ---------- channels --------------------------------------------------------------

  /** The team's channels. A personal one belongs to its owner, not to this list. */
  listShared(): NotifyChannelRecord[] {
    return this.store.list().filter((c) => c.userId === null);
  }

  listOwnedBy(userId: string | null): NotifyChannelRecord[] {
    if (userId === null) return [];
    return this.store.list().filter((c) => c.userId === userId);
  }

  get(id: string): NotifyChannelRecord | undefined {
    return this.store.get(id);
  }

  create(draft: NotifyChannelDraft): NotifyChannelRecord {
    const now = Date.now();
    const id = `nc-${randomUUID().slice(0, 12)}`;
    this.store.insert({
      id,
      workspaceId: draft.workspaceId,
      userId: draft.userId ?? null,
      kind: draft.kind,
      name: draft.name,
      url: draft.url,
      secret: draft.kind === 'webhook' ? (draft.secret ?? null) : null,
      kinds: draft.kinds,
      enabled: draft.enabled,
      createdAt: now,
      updatedAt: now,
    });
    this.changed();
    return this.store.get(id)!;
  }

  update(id: string, fields: Partial<NotifyChannelDraft>): NotifyChannelRecord {
    if (!this.store.get(id)) throw new Error('channel not found');
    this.store.update(id, {
      name: fields.name,
      // An empty url means "unchanged": the form never re-sends a credential it
      // was not shown, so blanking it here would silently break the channel.
      url: fields.url ? fields.url : undefined,
      secret: fields.secret === undefined ? undefined : fields.secret || null,
      kinds: fields.kinds,
      enabled: fields.enabled,
      workspaceId: fields.workspaceId,
    });
    this.changed();
    return this.store.get(id)!;
  }

  remove(id: string): void {
    if (this.store.delete(id)) this.changed();
  }

  deliveries(limit?: number): NotifyDeliveryRecord[] {
    return this.store.deliveries(limit);
  }

  /** The log, minus attempts against somebody else's personal channel. */
  deliveriesFor(userId: string | null, limit?: number): NotifyDeliveryRecord[] {
    const mine = new Set(this.store.list().filter((c) => c.userId === null || c.userId === userId).map((c) => c.id));
    return this.store.deliveries(limit).filter((d) => mine.has(d.channelId));
  }

  // ---------- delivery --------------------------------------------------------------

  /** Does this channel carry this notification? An empty filter carries every kind. */
  private accepts(target: ChannelTarget, notification: NotificationRecord): boolean {
    return target.kinds.length === 0 || target.kinds.includes(notification.kind);
  }

  /**
   * Deliver one notification to every channel that accepts it. Channels are
   * attempted concurrently and independently: one dead Slack webhook must not
   * delay or suppress a working one.
   */
  async fanOut(notification: NotificationRecord): Promise<void> {
    const targets = this.store
      .targetsFor(notification.workspaceId, notification.userId)
      .filter((t) => this.accepts(t, notification));
    if (targets.length === 0) return;
    await Promise.all(targets.map((target) => this.send(target, notification)));
    this.changed();
  }

  private async send(target: ChannelTarget, notification: NotificationRecord): Promise<void> {
    let outcome;
    try {
      const request = buildRequest(target.kind, target.url, notification, {
        publicUrl: this.publicUrl(),
        secret: target.secret,
      });
      outcome = await deliver(request);
    } catch (err) {
      // A malformed stored URL throws in buildRequest rather than in fetch.
      outcome = { ok: false, httpStatus: null, error: String(err instanceof Error ? err.message : err), attempts: 0 };
    }

    const status = outcome.ok ? 'delivered' : 'failed';
    this.store.recordAttempt(target.id, status, outcome.error);
    this.store.logDelivery({
      id: `nd-${randomUUID().slice(0, 12)}`,
      channelId: target.id,
      channelName: target.name,
      title: notification.title,
      status,
      httpStatus: outcome.httpStatus,
      error: outcome.error,
      attempts: outcome.attempts,
      createdAt: Date.now(),
    });
    if (!outcome.ok) {
      log.warn('outbound notification failed', { channel: target.name, kind: target.kind, err: outcome.error });
    }
  }

  /**
   * Send a synthetic notification so an operator can prove a channel works
   * without waiting for a real event. Returns the outcome instead of only
   * logging it: this one IS the answer to the request.
   */
  async test(id: string): Promise<NotifyTestResult> {
    const target = this.store.target(id);
    if (!target) throw new Error('channel not found');
    const probe: NotificationRecord = {
      id: `test-${randomUUID().slice(0, 8)}`,
      workspaceId: target.workspaceId,
      // Addressed as the channel is, or a personal channel would never match its
      // own test and would report "works" by not being tried.
      userId: target.userId,
      repo: null,
      kind: 'info',
      title: 'Companion test notification',
      body: `If you can read this, the "${target.name}" channel is wired up correctly.`,
      href: null,
      readAt: null,
      createdAt: Date.now(),
    };
    await this.send(target, probe);
    this.changed();
    const settled = this.store.get(id)!;
    return {
      status: settled.lastStatus ?? 'failed',
      httpStatus: this.store.deliveries(1)[0]?.httpStatus ?? null,
      error: settled.lastError,
    };
  }

  private changed(): void {
    this.broadcast({ t: 'notify.changed' });
  }
}
