// Import the contract of every module we depend on so their augmentations
// (permissions, services, messages, bus events) are visible in this compilation.
import '@companion/module-core/contract';
import '@companion/module-workspace/contract';
import '@companion/module-integrations/contract';
import type { NotifyService } from '../api/notify-service.js';

declare module '@moxxy/companion-contracts' {
  interface PermissionRegistry {
    'notify:read': true;
  }
  interface ServerMessageRegistry {
    'notify.changed': Record<never, never>;
  }
  interface ServiceMap {
    notify: NotifyService;
  }
}

export type NotifyDeliveryStatus = 'delivered' | 'failed';

/** One delivery attempt, kept as a bounded log so a silent channel is diagnosable. */
export interface NotifyDeliveryRecord {
  readonly id: string;
  readonly connectionId: string;
  readonly providerId: string;
  /** Denormalized so historical entries keep the label used at delivery time. */
  readonly connectionName: string;
  readonly title: string;
  readonly status: NotifyDeliveryStatus;
  /** HTTP status of the final attempt; null when the request never completed. */
  readonly httpStatus: number | null;
  readonly error: string | null;
  readonly attempts: number;
  readonly createdAt: number;
}
