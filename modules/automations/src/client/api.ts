import type { AskRequest, HistorySegment } from '@moxxy/companion-sdk/agents';
import { del, post, put, request } from '@moxxy/companion-sdk/client';
import type { BriefingCadence, RepoPreset, RepoPresetId, RepoPresetResult, RepoRecord, WebhookInfo } from '@companion/module-code/contract';
import type { RunRecord, WebhookTunnelState } from '@companion/module-operate/contract';
import type {
  ActionableIssueKind,
  AutomationAdmissionControl,
  AutomationDeliveryHealth,
  ContributorFlowDryRun,
  ContributorFlowMode,
  ContributorFlowPolicy,
  WorkspaceBriefingSchedule,
} from '../contract/index.js';

/**
 * module-automations' REST surface, carved from the legacy `lib/api.ts`: the
 * per-repo automation switches + webhook receivers, the tunnel status readout,
 * the on-demand digest/stale-sweep/briefing kicks, and AI Help (the per-user
 * conversation run). HTTP + token plumbing lives in `@moxxy/companion-core/client`;
 * every DTO is owned by the module it belongs to.
 */

export const automationsApi = {
  contributorFlows: (workspaceId: string) =>
    request<{ flows: ContributorFlowPolicy[] }>(`/api/workspaces/${workspaceId}/contributor-flows`),
  setContributorFlow: (
    workspaceId: string,
    fullName: string,
    input: {
      mode: ContributorFlowMode;
      actionableIssueKinds: readonly ActionableIssueKind[];
      queueIssues: boolean;
      autoApplyTriage: boolean;
      mergeMethod: ContributorFlowPolicy['mergeMethod'];
      maxAttempts: number;
      /** Omit to leave the stored value alone; null clears it. */
      admitLabel?: string | null;
    },
  ) =>
    put<{ flow: ContributorFlowPolicy | null; repo?: RepoRecord }>(
      `/api/workspaces/${workspaceId}/repos/${fullName}/contributor-flow`,
      input,
    ),
  admissionControls: (workspaceId: string) =>
    request<{ controls: AutomationAdmissionControl[] }>(`/api/workspaces/${workspaceId}/automation-admission`),
  setAdmissionControl: (
    workspaceId: string,
    fullName: string,
    input: { paused: boolean; reason?: string | null },
  ) =>
    put<{ control: AutomationAdmissionControl }>(
      `/api/workspaces/${workspaceId}/repos/${fullName}/automation-admission`,
      input,
    ),
  dryRunContributorFlow: (
    workspaceId: string,
    fullName: string,
    input: { mode: 'governed' | 'autonomous'; mergeMethod: ContributorFlowPolicy['mergeMethod'] },
  ) =>
    post<{ report: ContributorFlowDryRun }>(
      `/api/workspaces/${workspaceId}/repos/${fullName}/contributor-flow/dry-run`,
      input,
    ),
  deliveryHealth: (workspaceId: string) =>
    request<AutomationDeliveryHealth>(`/api/workspaces/${workspaceId}/automation-deliveries`),
  retryDelivery: (workspaceId: string, deliveryId: string) =>
    post<{ ok: true }>(`/api/workspaces/${workspaceId}/automation-deliveries/${deliveryId}/retry`),

  // per-repo automation switches + webhook receiver
  setAutomation: (
    fullName: string,
    fields: {
      autoTriage?: boolean;
      digest?: boolean;
      staleSweep?: boolean;
      prGate?: boolean;
      autoMerge?: boolean;
      reviewReplies?: boolean;
    },
  ) => post<{ repo: RepoRecord }>(`/api/repos/${fullName}/automation`, fields),
  /** The preset catalogue, served so the choices and what they write cannot drift. */
  repoPresets: () => request<{ presets: RepoPreset[] }>('/api/repo-presets'),
  applyPreset: (fullName: string, preset: RepoPresetId) =>
    post<{ repo: RepoRecord; result: RepoPresetResult }>(`/api/repos/${fullName}/preset`, { preset }),
  enableWebhook: (fullName: string, accountId: string) =>
    post<WebhookInfo>(`/api/repos/${fullName}/webhook`, { accountId }),
  disableWebhook: (fullName: string) => del<{ ok: true; warning: string | null }>(`/api/repos/${fullName}/webhook`),
  /** Read-only: never (re-)enables the receiver. */
  getWebhook: (fullName: string) => request<{ webhook: WebhookInfo | null }>(`/api/repos/${fullName}/webhook`),
  /** Instance-wide tunnel state; configuration remains kernel-owned module config. */
  webhookTunnel: () => request<WebhookTunnelState>('/api/webhooks/tunnel'),
  retryWebhookTunnel: () => post<WebhookTunnelState>('/api/webhooks/tunnel/retry'),
  digestNow: (fullName: string) => post<{ ok: true }>(`/api/repos/${fullName}/digest-now`),
  staleNow: (fullName: string) => post<{ ok: true }>(`/api/repos/${fullName}/stale-now`),

  // workspace briefing
  getBriefing: (workspaceId: string) => request<WorkspaceBriefingSchedule>(`/api/workspaces/${workspaceId}/briefing`),
  setBriefing: (workspaceId: string, cadence: BriefingCadence) =>
    put<WorkspaceBriefingSchedule>(`/api/workspaces/${workspaceId}/briefing`, { cadence }),
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
