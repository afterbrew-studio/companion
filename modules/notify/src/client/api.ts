import { qs, request } from '@moxxy/companion-sdk/client';
import type { NotifyDeliveryRecord } from '../contract/index.js';

export const notifyApi = {
  deliveries: (opts?: { limit?: number }) =>
    request<{ deliveries: NotifyDeliveryRecord[] }>(`/api/notify/deliveries${qs({ limit: opts?.limit })}`),
};
