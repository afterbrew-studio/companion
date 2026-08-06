import { request } from '@moxxy/companion-sdk/client';
import type { NotifyDeliveryRecord } from '../contract/index.js';

export const notifyApi = {
  deliveries: () => request<{ deliveries: NotifyDeliveryRecord[] }>('/api/notify/deliveries'),
};
