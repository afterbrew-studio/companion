import { put, request } from '@moxxy/companion-sdk/client';
import type { ModelRouterPolicy, ModelRouterPolicyUpdate, ModelRouterSnapshot } from '../contract/index.js';

export const modelRouterApi = {
  snapshot: () => request<ModelRouterSnapshot>('/api/model-router'),
  updatePolicy: (body: ModelRouterPolicyUpdate) =>
    put<{ policy: ModelRouterPolicy }>('/api/model-router/policy', body),
};
