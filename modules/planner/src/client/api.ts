import { patch, post, put, request } from '@companion/core/client';
import type { RefineItemUpdate } from '@companion/module-refinement/contract';
import type {
  ArtifactBundle,
  FeatureBrief,
  FeaturePlanningSession,
  PlannerDiscussionContext,
  PlannerSessionDetail,
} from '../contract/index.js';

const revision = (expectedRevision: number): { expectedRevision: number } => ({ expectedRevision });

export const ideasApi = {
  list: (workspaceId: string) => request<{ sessions: FeaturePlanningSession[]; legacyActiveCount: number }>(`/api/workspaces/${workspaceId}/ideas`),
  create: (input: { workspaceId: string; repo: string; idea: string; title?: string }) =>
    post<{ session: FeaturePlanningSession }>('/api/ideas', input),
  get: (id: string) => request<PlannerSessionDetail>(`/api/ideas/${id}`),
  clarify: (id: string, expectedRevision: number) => post<{ session: FeaturePlanningSession }>(`/api/ideas/${id}/clarify`, revision(expectedRevision)),
  answer: (id: string, expectedRevision: number, answers: Array<{ questionId: string; optionId?: string | null; value?: string }>) =>
    post<{ session: FeaturePlanningSession }>(`/api/ideas/${id}/answers`, { expectedRevision, answers }),
  confirmBrief: (id: string, expectedRevision: number, brief: FeatureBrief) =>
    post<{ session: FeaturePlanningSession }>(`/api/ideas/${id}/confirm-brief`, { expectedRevision, brief }),
  saveArtifacts: (id: string, expectedRevision: number, artifacts: ArtifactBundle) =>
    put<{ session: FeaturePlanningSession }>(`/api/ideas/${id}/artifacts`, { expectedRevision, artifacts }),
  createArtifacts: (id: string, expectedRevision: number) => post<{ session: FeaturePlanningSession }>(`/api/ideas/${id}/create-artifacts`, revision(expectedRevision)),
  analyze: (id: string, expectedRevision: number) => post<{ session: FeaturePlanningSession }>(`/api/ideas/${id}/analyze`, revision(expectedRevision)),
  retry: (id: string, expectedRevision: number) => post<{ session: FeaturePlanningSession }>(`/api/ideas/${id}/retry`, revision(expectedRevision)),
  requestRevision: (id: string, expectedRevision: number, instruction: string) =>
    post<{ session: FeaturePlanningSession }>(`/api/ideas/${id}/revision`, { expectedRevision, instruction }),
  discuss: (id: string, expectedRevision: number, message: string, context?: PlannerDiscussionContext) =>
    post<{ session: FeaturePlanningSession }>(`/api/ideas/${id}/discuss`, { expectedRevision, message, ...(context ? { context } : {}) }),
  applyRevision: (id: string, expectedRevision: number) => post<{ session: FeaturePlanningSession }>(`/api/ideas/${id}/apply-revision`, revision(expectedRevision)),
  discardRevision: (id: string, expectedRevision: number) => post<{ session: FeaturePlanningSession }>(`/api/ideas/${id}/discard-revision`, revision(expectedRevision)),
  prepareTasks: (id: string, expectedRevision: number) => post<{ session: FeaturePlanningSession }>(`/api/ideas/${id}/prepare-tasks`, revision(expectedRevision)),
  updateItem: (id: string, itemId: string, expectedRevision: number, fields: RefineItemUpdate) =>
    patch<{ session: FeaturePlanningSession }>(`/api/ideas/${id}/items/${itemId}`, { expectedRevision, ...fields }),
  moveItem: (id: string, itemId: string, expectedRevision: number, direction: 'up' | 'down') =>
    post<{ session: FeaturePlanningSession }>(`/api/ideas/${id}/items/${itemId}/move`, { expectedRevision, direction }),
  dismissItem: (id: string, itemId: string, expectedRevision: number) =>
    post<{ session: FeaturePlanningSession }>(`/api/ideas/${id}/items/${itemId}/dismiss`, revision(expectedRevision)),
  mergeItems: (id: string, expectedRevision: number, itemIds: string[]) =>
    post<{ session: FeaturePlanningSession }>(`/api/ideas/${id}/items/merge`, { expectedRevision, itemIds }),
  launch: (id: string, expectedRevision: number) => post<{ session: FeaturePlanningSession }>(`/api/ideas/${id}/launch`, revision(expectedRevision)),
  stop: (id: string, expectedRevision: number) => post<{ session: FeaturePlanningSession }>(`/api/ideas/${id}/stop`, revision(expectedRevision)),
  cancel: (id: string, expectedRevision: number) => post<{ session: FeaturePlanningSession }>(`/api/ideas/${id}/cancel`, revision(expectedRevision)),
};
