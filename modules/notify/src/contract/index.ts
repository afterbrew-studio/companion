// Import the contract of every module we depend on so their augmentations
// (permissions, services, messages, bus events) are visible in this compilation.
import '@companion/module-core/contract';
import '@companion/module-workspace/contract';
import type { NotificationKind } from '@companion/module-workspace/contract';
import type { NotifyService } from '../api/notify-service.js';

declare module '@moxxy/companion-contracts' {
  interface PermissionRegistry {
    'notify:read': true;
    'notify:manage': true;
    'notify:self': true;
  }
  interface ServerMessageRegistry {
    'notify.changed': Record<never, never>;
  }
  interface ServiceMap {
    notify: NotifyService;
  }
}

/**
 * Where an inbox entry is forwarded. All four are one HTTP POST with a
 * different body, which is why there is no dependency here: adding a kind is a
 * union member and a payload builder.
 */
export type NotifyChannelKind = 'webhook' | 'slack' | 'discord' | 'ntfy';

export type NotifyDeliveryStatus = 'delivered' | 'failed';

/**
 * A configured destination. The target URL is a credential (a Slack webhook URL
 * is enough to post into that channel), so it never leaves the daemon: the
 * client sees `targetHint`, which is host plus an elided path.
 */
export interface NotifyChannelRecord {
  readonly id: string;
  /**
   * Whose channel this is. null is shared and carries only workspace-wide events;
   * a value makes it personal and carries only what is addressed to that person.
   * The two never overlap, so nobody's channel is a firehose of everyone's work.
   */
  readonly userId: string | null;
  /** Workspace whose notifications this delivers; null = every workspace. */
  readonly workspaceId: string | null;
  readonly kind: NotifyChannelKind;
  readonly name: string;
  /** Redacted destination for display, e.g. `hooks.slack.com/services/…`. */
  readonly targetHint: string;
  readonly enabled: boolean;
  /** Notification kinds delivered; empty means every kind. */
  readonly kinds: ReadonlyArray<NotificationKind>;
  /** A generic webhook body is HMAC-signed when a secret is set (flag only). */
  readonly signed: boolean;
  readonly lastStatus: NotifyDeliveryStatus | null;
  readonly lastError: string | null;
  readonly lastAttemptAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Create/update payload. `url` and `secret` are write-only. */
export interface NotifyChannelDraft {
  readonly workspaceId: string | null;
  /** Omit for a shared channel; a personal one is always owned by the caller. */
  readonly userId?: string | null;
  readonly kind: NotifyChannelKind;
  readonly name: string;
  readonly url: string;
  readonly kinds: ReadonlyArray<NotificationKind>;
  /** HMAC secret for `webhook` channels; ignored by the others. */
  readonly secret?: string;
  readonly enabled: boolean;
}

/** One delivery attempt, kept as a bounded log so a silent channel is diagnosable. */
export interface NotifyDeliveryRecord {
  readonly id: string;
  readonly channelId: string;
  /** Denormalized: the log stays readable after a channel is renamed or deleted. */
  readonly channelName: string;
  readonly title: string;
  readonly status: NotifyDeliveryStatus;
  /** HTTP status of the final attempt; null when the request never completed. */
  readonly httpStatus: number | null;
  readonly error: string | null;
  readonly attempts: number;
  readonly createdAt: number;
}

/** Result of the "send a test message" action. */
export interface NotifyTestResult {
  readonly status: NotifyDeliveryStatus;
  readonly httpStatus: number | null;
  readonly error: string | null;
}
