import { del, patch, post, request } from '@moxxy/companion-sdk/client';
import type {
  CreateMcpServerRequest,
  CreateProviderRequest,
  McpCheckResult,
  McpServerRecord,
  ModelProviderRecord,
  ProbeResult,
} from '../contract/index.js';

export const runtimeApi = {
  providers: () => request<{ providers: ModelProviderRecord[]; ready: boolean }>('/api/model-providers'),
  create: (draft: CreateProviderRequest) =>
    post<{ provider: ModelProviderRecord }>('/api/model-providers', draft),
  update: (id: string, fields: Partial<CreateProviderRequest>) =>
    patch<{ provider: ModelProviderRecord }>(`/api/model-providers/${id}`, fields),
  remove: (id: string) => del<{ ok: true }>(`/api/model-providers/${id}`),
  availableModels: (id: string) => request<{ models: string[] }>(`/api/model-providers/${id}/available-models`),
  probe: (id: string, model: string) =>
    post<{ result: ProbeResult }>(`/api/model-providers/${id}/probe`, { model }),
};

export const mcpApi = {
  servers: () => request<{ servers: McpServerRecord[] }>('/api/mcp-servers'),
  create: (draft: CreateMcpServerRequest) => post<{ server: McpServerRecord }>('/api/mcp-servers', draft),
  update: (id: string, fields: Partial<CreateMcpServerRequest>) =>
    patch<{ server: McpServerRecord }>(`/api/mcp-servers/${id}`, fields),
  remove: (id: string) => del<{ ok: true }>(`/api/mcp-servers/${id}`),
  check: (id: string) => post<{ result: McpCheckResult }>(`/api/mcp-servers/${id}/check`, {}),
};
