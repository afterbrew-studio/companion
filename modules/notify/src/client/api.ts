import { del, patch, post, request } from '@moxxy/companion-sdk/client';
import type {
  NotifyChannelDraft,
  NotifyChannelRecord,
  NotifyDeliveryRecord,
  NotifyTestResult,
} from '../contract/index.js';

export const notifyApi = {
  channels: () => request<{ channels: NotifyChannelRecord[] }>('/api/notify/channels'),
  deliveries: () => request<{ deliveries: NotifyDeliveryRecord[] }>('/api/notify/deliveries'),
  create: (draft: NotifyChannelDraft) => post<{ channel: NotifyChannelRecord }>('/api/notify/channels', draft),
  update: (id: string, fields: Partial<NotifyChannelDraft>) =>
    patch<{ channel: NotifyChannelRecord }>(`/api/notify/channels/${id}`, fields),
  remove: (id: string) => del<{ ok: true }>(`/api/notify/channels/${id}`),
  test: (id: string) => post<NotifyTestResult>(`/api/notify/channels/${id}/test`),
};
