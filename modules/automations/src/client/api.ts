import type { AskRequest, HistorySegment } from '@moxxy-ai/companion-sdk/agents';
import { del, post, put, request } from '@moxxy-ai/companion-sdk/client';
import type { BriefingCadence, RepoRecord, WebhookInfo } from '@companion/module-code/contract';
import type { RunRecord, WebhookTunnelState } from '@companion/module-operate/contract';

/**
 * module-automations' REST surface, carved from the legacy `lib/api.ts`: the
 * per-repo automation switches + webhook receivers, the tunnel status readout,
 * the on-demand digest/stale-sweep/briefing kicks, and AI Help (the per-user
 * conversation run). HTTP + token plumbing lives in `@companion/core/client`;
 * every DTO is owned by the module it belongs to.
 */

export const automationsApi = {
  // per-repo automation switches + webhook receiver
  setAutomation: (
    fullName: string,
    fields: { autoTriage?: boolean; digest?: boolean; staleSweep?: boolean; prGate?: boolean; autoMerge?: boolean },
  ) => post<{ repo: RepoRecord }>(`/api/repos/${fullName}/automation`, fields),
  enableWebhook: (fullName: string, accountId: string) =>
    post<WebhookInfo>(`/api/repos/${fullName}/webhook`, { accountId }),
  disableWebhook: (fullName: string) => del<{ ok: true }>(`/api/repos/${fullName}/webhook`),
  /** Read-only: never (re-)enables the receiver. */
  getWebhook: (fullName: string) => request<{ webhook: WebhookInfo | null }>(`/api/repos/${fullName}/webhook`),
  /** Instance-wide tunnel state; configuration remains kernel-owned module config. */
  webhookTunnel: () => request<WebhookTunnelState>('/api/webhooks/tunnel'),
  retryWebhookTunnel: () => post<WebhookTunnelState>('/api/webhooks/tunnel/retry'),
  digestNow: (fullName: string) => post<{ ok: true }>(`/api/repos/${fullName}/digest-now`),
  staleNow: (fullName: string) => post<{ ok: true }>(`/api/repos/${fullName}/stale-now`),

  // workspace briefing
  getBriefing: (workspaceId: string) => request<{ cadence: BriefingCadence }>(`/api/workspaces/${workspaceId}/briefing`),
  setBriefing: (workspaceId: string, cadence: BriefingCadence) =>
    put<{ cadence: BriefingCadence }>(`/api/workspaces/${workspaceId}/briefing`, { cadence }),
  briefingNow: (workspaceId: string) => post<{ ok: true }>(`/api/workspaces/${workspaceId}/briefing-now`),

  // AI Help assistant (per-user conversation run)
  assistant: () => request<{ run: RunRecord | null; pendingAsks: AskRequest[] }>('/api/assistant'),
  assistantSession: () => post<{ run: RunRecord; pendingAsks: AskRequest[] }>('/api/assistant/session'),
  assistantMessage: (text: string, repo?: string) =>
    post<{ turnId: string }>('/api/assistant/message', { text, repo }),
  assistantHistory: (before: number | null, limit = 300) =>
    request<HistorySegment>(`/api/assistant/history?limit=${limit}${before === null ? '' : `&before=${before}`}`),
  assistantAsk: (requestId: string, response: Record<string, unknown>) =>
    post<{ ok: true }>('/api/assistant/ask', { requestId, response }),
  assistantAbort: () => post<{ ok: true }>('/api/assistant/abort'),
  assistantReset: () => post<{ ok: true }>('/api/assistant/reset'),
};
