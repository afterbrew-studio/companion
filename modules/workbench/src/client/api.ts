import { post, qs, request } from '@moxxy/companion-sdk/client';
import type {
  DecisionSnapshot,
  PreparedWorkbenchAction,
  WorkbenchActionDefinition,
  WorkbenchActionRequest,
  WorkbenchActionSource,
  WorkbenchActionStatus,
} from '../contract/index.js';

export const workbenchApi = {
  decisions: (workspaceId: string) =>
    request<DecisionSnapshot>(`/api/workbench/decisions${qs({ workspace: workspaceId })}`),
  actionCatalog: () =>
    request<{ actions: readonly WorkbenchActionDefinition[] }>('/api/workbench/actions/catalog'),
  actions: (workspaceId?: string, status?: WorkbenchActionStatus) =>
    request<{ actions: readonly PreparedWorkbenchAction[] }>(
      `/api/workbench/actions${qs({ workspace: workspaceId, status })}`,
    ),
  prepareAction: (
    workspaceId: string,
    action: WorkbenchActionRequest,
    source?: Exclude<WorkbenchActionSource, 'assistant'>,
  ) => post<{ action: PreparedWorkbenchAction }>(
    `/api/workbench/actions/${encodeURIComponent(action.action)}/prepare`,
    { workspaceId, request: action, source },
  ),
  executeAction: (id: string, action: WorkbenchActionRequest['action']) =>
    post<{ action: PreparedWorkbenchAction }>(
      `/api/workbench/actions/${encodeURIComponent(action)}/${encodeURIComponent(id)}/execute`,
    ),
  cancelAction: (id: string) =>
    post<{ action: PreparedWorkbenchAction }>(`/api/workbench/actions/${encodeURIComponent(id)}/cancel`),
};
