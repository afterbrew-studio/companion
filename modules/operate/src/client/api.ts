import type { AskRequest, HistorySegment, ProvisionProviderSpec } from '@moxxy/companion-types';
import { del, patch, post, put, request } from '@moxxy/companion-core/client';
import type {
  BudgetStatus,
  CreateRunnerRequest,
  ModelCatalog,
  MoxxyStatus,
  ProviderCatalog,
  RunQueueSnapshot,
  RunRecord,
  RunnerMoxxyUpdateResult,
  RunnerCapacitySnapshot,
  RunnerPolicyOptions,
  RunnerProbeResult,
  RunnerProviderPolicy,
  RunnerRecord,
  RunTaskDescriptor,
  SkillFile,
  SpendBreakdown,
  TaskModelSnapshot,
  TokenUsage,
  UpdateRunnerRequest,
} from '../contract/index.js';

/**
 * module-operate's REST surface, carved from the legacy `lib/api.ts`: the agent
 * runs family + the run queue, runner machines, provider/model settings, the
 * moxxy status probe, and skills. HTTP + token plumbing lives in
 * `@moxxy/companion-core/client`.
 */

export const operateApi = {
  status: () => request<MoxxyStatus>('/api/status'),

  // runs
  listRuns: () => request<{ runs: RunRecord[] }>('/api/runs'),
  createRun: (title?: string) => post<{ run: RunRecord }>('/api/runs', { title }),
  getRun: (id: string) => request<{ run: RunRecord; pendingAsks: AskRequest[] }>(`/api/runs/${id}`),
  history: (id: string, before: number | null, limit = 300) =>
    request<HistorySegment>(`/api/runs/${id}/history?limit=${limit}${before === null ? '' : `&before=${before}`}`),
  runDiff: (id: string) => request<{ diff: string; branch: string | null }>(`/api/runs/${id}/diff`),
  runModels: (id: string) => request<ModelCatalog>(`/api/runs/${id}/models`),
  setRunModel: (id: string, model: string | null, provider?: string) =>
    post<{ run: RunRecord }>(`/api/runs/${id}/model`, { model, provider }),
  approvePr: (id: string, title?: string, body?: string) =>
    post<{ prUrl: string }>(`/api/runs/${id}/approve-pr`, { title, body }),
  discardRun: (id: string) => post<{ ok: true }>(`/api/runs/${id}/discard`),
  prompt: (id: string, prompt: string) => post<{ turnId: string }>(`/api/runs/${id}/prompt`, { prompt }),
  abort: (id: string, turnId?: string) => post<{ ok: true }>(`/api/runs/${id}/abort`, { turnId }),
  respondAsk: (id: string, requestId: string, response: Record<string, unknown>) =>
    post<{ ok: true }>(`/api/runs/${id}/ask`, { requestId, response }),
  resumeRun: (id: string) => post<{ run: RunRecord }>(`/api/runs/${id}/resume`),
  stopRun: (id: string) => post<{ ok: true }>(`/api/runs/${id}/stop`),
  tokenUsage: () => request<TokenUsage>('/api/runs/usage'),
  budget: () => request<BudgetStatus>('/api/budget'),
  spendBreakdown: () => request<SpendBreakdown>('/api/budget/spend'),

  // the run scheduler's waiting line
  runQueue: () => request<{ queue: RunQueueSnapshot }>('/api/runs/queue'),
  moveQueued: (id: string, direction: 'up' | 'down') =>
    post<{ queue: RunQueueSnapshot }>(`/api/runs/queue/${id}/move`, { direction }),
  cancelQueued: (id: string) => del<{ queue: RunQueueSnapshot }>(`/api/runs/queue/${id}`),

  // runners (execution machines)
  listRunners: () => request<{ runners: RunnerRecord[]; tasks: RunTaskDescriptor[] }>('/api/runners'),
  runnerOptions: () => request<RunnerPolicyOptions>('/api/runners/options'),
  runnerCapacity: () => request<RunnerCapacitySnapshot>('/api/runners/capacity'),
  createRunner: (body: CreateRunnerRequest) => post<{ runner: RunnerRecord }>('/api/runners', body),
  updateRunner: (id: string, body: UpdateRunnerRequest) =>
    patch<{ runner: RunnerRecord }>(`/api/runners/${id}`, body),
  deleteRunner: (id: string) => del<{ ok: true }>(`/api/runners/${id}`),
  probeRunner: (id: string) => post<RunnerProbeResult>(`/api/runners/${id}/probe`),
  // Adding a provider answers with the machine's re-probe: health and catalog
  // as it reports them now. The key travels one way only.
  addRunnerProvider: (id: string, spec: ProvisionProviderSpec) =>
    post<RunnerProbeResult>(`/api/runners/${id}/providers`, spec),
  updateRunnerMoxxy: (id: string) => post<RunnerMoxxyUpdateResult>(`/api/runners/${id}/update-moxxy`),

  // providers + models (grouped per machine; machines fetch their own catalog)
  providerCatalog: () => request<ProviderCatalog>('/api/providers'),
  setRunnerProviderPolicy: (runnerId: string, policy: RunnerProviderPolicy) =>
    put<ProviderCatalog>(`/api/runners/${runnerId}/providers`, policy),
  refreshProviderCatalog: () => post<ProviderCatalog>('/api/providers/refresh'),

  // model pins (per registered task)
  taskModels: () => request<TaskModelSnapshot>('/api/settings/task-models'),
  setTaskModel: (taskId: string, model: string | null) =>
    put<TaskModelSnapshot>('/api/settings/task-models', { pins: { [taskId]: model } }),

  // skills
  listSkills: () => request<{ skills: SkillFile[] }>('/api/skills'),
  saveSkill: (name: string, content: string) => put<{ skill: SkillFile }>(`/api/skills/${name}`, { content }),
  deleteSkill: (name: string) => del<{ ok: true }>(`/api/skills/${name}`),
  generateSkill: (instructions: string) =>
    post<{ draft: { name: string; content: string } }>('/api/skills/generate', { instructions }),
};
