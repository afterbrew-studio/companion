import { request, post } from '@moxxy/companion-sdk/client';
import type { PipelinePreview, PlaygroundRunRequest, PlaygroundRunResult } from '../contract/index.js';

/** module-playground's REST surface: one fenced test run + the pipeline preview. */
export const playgroundApi = {
  run: (body: PlaygroundRunRequest) => post<PlaygroundRunResult>('/api/playground/run', body),
  pipelinePreview: (repo: string, pipelineId: string, prNumber: number) =>
    request<PipelinePreview>(
      `/api/playground/pipeline-preview?repo=${encodeURIComponent(repo)}&pipelineId=${encodeURIComponent(pipelineId)}&pr=${prNumber}`,
    ),
};
