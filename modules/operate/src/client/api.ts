import type { AskRequest, HistorySegment } from '@companion/types';
import { del, patch, post, put, request } from '@companion/core/client';
import type {
  CreateRunnerRequest,
  ModelCatalog,
  ModelCatalogProvider,
  MoxxyStatus,
  RunQueueSnapshot,
  RunRecord,
  RunSettings,
  RunnerProbeResult,
  RunnerRecord,
  SkillFile,
  UpdateRunnerRequest,
} from '../contract/index.js';

/**
 * module-operate's REST surface, carved from the legacy `lib/api.ts`: the agent
 * runs family + the run queue, runner machines, provider/model settings, the
 * moxxy status probe, and skills. HTTP + token plumbing lives in
 * `@companion/core/client`.
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

  // the run scheduler's waiting line
  runQueue: () => request<{ queue: RunQueueSnapshot }>('/api/runs/queue'),
  moveQueued: (id: string, direction: 'up' | 'down') =>
    post<{ queue: RunQueueSnapshot }>(`/api/runs/queue/${id}/move`, { direction }),
  cancelQueued: (id: string) => del<{ queue: RunQueueSnapshot }>(`/api/runs/queue/${id}`),

  // runners (execution machines)
  listRunners: () => request<{ runners: RunnerRecord[] }>('/api/runners'),
  createRunner: (body: CreateRunnerRequest) => post<{ runner: RunnerRecord }>('/api/runners', body),
  updateRunner: (id: string, body: UpdateRunnerRequest) =>
    patch<{ runner: RunnerRecord }>(`/api/runners/${id}`, body),
  deleteRunner: (id: string) => del<{ ok: true }>(`/api/runners/${id}`),
  probeRunner: (id: string) => post<RunnerProbeResult>(`/api/runners/${id}/probe`),

  // providers + models
  importProviders: () => post<{ imported: string[]; missing: string[] }>('/api/moxxy/import-providers'),
  getModelsCatalog: () =>
    request<{ providers: ModelCatalogProvider[]; defaultModel: string; fresh: boolean }>('/api/models-catalog'),
  getProviderSettings: () =>
    request<{ providers: Array<{ name: string; enabled: boolean }>; disabledModels: string[] }>(
      '/api/settings/providers',
    ),
  setProviderSettings: (disabledProviders: string[], disabledModels: string[]) =>
    put<{ ok: true }>('/api/settings/providers', { disabledProviders, disabledModels }),

  // model pins (per action kind)
  getModelPins: () =>
    request<{ pins: Record<string, string | null>; defaultModel: string }>('/api/settings/model-pins'),
  setModelPins: (pins: Record<string, string | null>) =>
    put<{ pins: Record<string, string | null> }>('/api/settings/model-pins', { pins }),

  // instance run-scheduling settings (admin)
  getRunSettings: () => request<RunSettings>('/api/settings/runs'),
  setRunSettings: (reservedRunnerSlots: number) =>
    put<RunSettings>('/api/settings/runs', { reservedRunnerSlots }),

  // skills
  listSkills: () => request<{ skills: SkillFile[] }>('/api/skills'),
  saveSkill: (name: string, content: string) => put<{ skill: SkillFile }>(`/api/skills/${name}`, { content }),
  deleteSkill: (name: string) => del<{ ok: true }>(`/api/skills/${name}`),
  generateSkill: (instructions: string) =>
    post<{ draft: { name: string; content: string } }>('/api/skills/generate', { instructions }),
};
