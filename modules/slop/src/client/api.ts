import { del, post, put, request } from '@moxxy/companion-sdk/client';
import type {
  SlopAction,
  SlopDetectionResult,
  SlopMoveToRefinementResult,
  SlopRuleDraft,
  SlopRuleRecord,
} from '../contract/index.js';

export const slopApi = {
  list: (workspaceId: string) =>
    request<{ detections: SlopDetectionResult[] }>(`/api/workspaces/${workspaceId}/slop`),
  rules: (workspaceId: string) =>
    request<{ rules: SlopRuleRecord[] }>(`/api/workspaces/${workspaceId}/slop-rules`),
  createRule: (workspaceId: string, fields: { name: string; description: string; instructions: string }) =>
    post<{ rule: SlopRuleRecord }>(`/api/workspaces/${workspaceId}/slop-rules`, fields),
  generateRule: (workspaceId: string, prompt: string) =>
    post<{ draft: SlopRuleDraft }>(`/api/workspaces/${workspaceId}/slop-rules/generate`, { prompt }),
  updateRule: (id: string, fields: { name?: string; description?: string; instructions?: string }) =>
    put<{ rule: SlopRuleRecord }>(`/api/slop-rules/${id}`, fields),
  deleteRule: (id: string) => del<{ ok: true }>(`/api/slop-rules/${id}`),
  toggleRule: (id: string, workspaceId: string, enabled: boolean) =>
    post<{ ok: true }>(`/api/slop-rules/${id}/toggle`, { workspaceId, enabled }),
  detect: (repo: string, prNumber: number) =>
    post<{ queued: true }>(`/api/repos/${repo}/prs/${prNumber}/slop-detect`),
  detectionsForPr: (repo: string, prNumber: number) =>
    request<{ detections: SlopDetectionResult[] }>(`/api/repos/${repo}/prs/${prNumber}/slop`),
  get: (id: string) => request<{ detection: SlopDetectionResult }>(`/api/slop/${id}`),
  apply: (id: string, body: { action?: SlopAction; accountId?: string }) =>
    post<{ repo: string; number: number; action: SlopAction }>(`/api/slop/${id}/apply`, body),
  dismiss: (id: string) => post<{ ok: true }>(`/api/slop/${id}/dismiss`),
  moveToRefinement: (id: string, workspaceId: string) =>
    post<SlopMoveToRefinementResult>(`/api/slop/${id}/move-to-refinement`, { workspaceId }),
};
