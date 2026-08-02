import { del, post, put, request } from '@moxxy/companion-sdk/client';
import type {
  PipelinePreview,
  PlaygroundEvaluationCaseInput,
  PlaygroundEvaluationCaseRecord,
  PlaygroundEvaluationRun,
  PlaygroundEvaluationSnapshot,
  PlaygroundProductionEvaluationRun,
  PlaygroundProductionEvaluationSnapshot,
  PlaygroundProductionEvaluationSuite,
  PlaygroundRunRequest,
  PlaygroundRunResult,
} from '../contract/index.js';

/** Fenced one-shots, saved deterministic evaluations, and pipeline preview. */
export const playgroundApi = {
  run: (body: PlaygroundRunRequest) => post<PlaygroundRunResult>('/api/playground/run', body),
  evaluationCases: () => request<PlaygroundEvaluationSnapshot>('/api/playground/evaluation-cases'),
  createEvaluationCase: (body: PlaygroundEvaluationCaseInput) =>
    post<{ evaluationCase: PlaygroundEvaluationCaseRecord }>('/api/playground/evaluation-cases', body),
  updateEvaluationCase: (id: string, expectedRevision: number, body: PlaygroundEvaluationCaseInput) =>
    put<{ evaluationCase: PlaygroundEvaluationCaseRecord }>(`/api/playground/evaluation-cases/${id}`, {
      ...body,
      expectedRevision,
    }),
  deleteEvaluationCase: (id: string) => del<{ ok: true }>(`/api/playground/evaluation-cases/${id}`),
  runEvaluationCase: (id: string) =>
    post<{ evaluationRun: PlaygroundEvaluationRun }>(`/api/playground/evaluation-cases/${id}/run`, {}),
  productionEvaluations: () =>
    request<PlaygroundProductionEvaluationSnapshot>('/api/playground/production-evaluations'),
  runProductionEvaluation: (id: string) =>
    post<{ evaluationRun: PlaygroundProductionEvaluationRun }>(
      `/api/playground/production-evaluations/${encodeURIComponent(id)}/run`,
      {},
    ),
  cancelProductionEvaluation: (id: string) =>
    post<{ ok: true }>(`/api/playground/production-evaluations/${encodeURIComponent(id)}/cancel`, {}),
  startProductionEvaluationSuite: () =>
    post<{ evaluationSuite: PlaygroundProductionEvaluationSuite }>(
      '/api/playground/production-evaluations/run-all',
      {},
    ),
  cancelProductionEvaluationSuite: (id: string) =>
    post<{ ok: true }>(
      `/api/playground/production-evaluations/suites/${encodeURIComponent(id)}/cancel`,
      {},
    ),
  pipelinePreview: (repo: string, pipelineId: string, prNumber: number) =>
    request<PipelinePreview>(
      `/api/playground/pipeline-preview?repo=${encodeURIComponent(repo)}&pipelineId=${encodeURIComponent(pipelineId)}&pr=${prNumber}`,
    ),
};
