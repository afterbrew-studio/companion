import { del, patch, post, request } from '@moxxy/companion-sdk/client';
import type { CreateProviderRequest, ModelProviderRecord, ProbeResult } from '../contract/index.js';

export const runtimeApi = {
  providers: () => request<{ providers: ModelProviderRecord[]; ready: boolean }>('/api/model-providers'),
  create: (draft: CreateProviderRequest) =>
    post<{ provider: ModelProviderRecord }>('/api/model-providers', draft),
  update: (id: string, fields: Partial<CreateProviderRequest>) =>
    patch<{ provider: ModelProviderRecord }>(`/api/model-providers/${id}`, fields),
  remove: (id: string) => del<{ ok: true }>(`/api/model-providers/${id}`),
  probe: (id: string, model: string) =>
    post<{ result: ProbeResult }>(`/api/model-providers/${id}/probe`, { model }),
};
