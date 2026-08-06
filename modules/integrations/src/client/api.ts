import { del, patch, post, put, request } from '@moxxy/companion-sdk/client';
import type {
  EffectiveIntegrationRoute,
  IntegrationCapability,
  IntegrationCatalog,
  IntegrationConnectionDraft,
  IntegrationConnectionRecord,
  IntegrationFieldValue,
  IntegrationRouteRecord,
  IntegrationScope,
  IntegrationTargetRef,
} from '../contract/index.js';

export type IntegrationConnectionPatch = {
  readonly name?: string;
  readonly scope?: IntegrationScope;
  readonly enabled?: boolean;
  readonly config?: Readonly<Record<string, IntegrationFieldValue | null>>;
};

function scopeQuery(scope: IntegrationScope): string {
  const query = new URLSearchParams({ scope: scope.kind });
  if (scope.kind !== 'instance') query.set('workspaceId', scope.workspaceId);
  if (scope.kind === 'repository') query.set('repo', scope.repo);
  return query.toString();
}

export const integrationsApi = {
  catalog: () => request<IntegrationCatalog>('/api/integrations/catalog'),
  create: (draft: IntegrationConnectionDraft, personal = false) =>
    post<{ connection: IntegrationConnectionRecord }>(
      `/api/integrations/connections${personal ? '/mine' : ''}`,
      draft,
    ),
  update: (id: string, input: IntegrationConnectionPatch, personal = false) =>
    patch<{ connection: IntegrationConnectionRecord }>(
      `/api/integrations/connections${personal ? '/mine' : ''}/${id}`,
      input,
    ),
  remove: (id: string, personal = false) =>
    del<{ ok: true }>(`/api/integrations/connections${personal ? '/mine' : ''}/${id}`),
  test: (id: string, personal = false) =>
    post<{ connection: IntegrationConnectionRecord }>(
      `/api/integrations/connections${personal ? '/mine' : ''}/${id}/test`,
      {},
    ),
  route: (capability: IntegrationCapability, scope: IntegrationScope) =>
    request<{ route: EffectiveIntegrationRoute }>(
      `/api/integrations/routes/${encodeURIComponent(capability)}?${scopeQuery(scope)}`,
    ),
  setRoute: (
    capability: IntegrationCapability,
    scope: IntegrationScope,
    targets: readonly IntegrationTargetRef[],
  ) =>
    put<{ route: IntegrationRouteRecord }>(`/api/integrations/routes/${encodeURIComponent(capability)}`, {
      scope,
      targets,
    }),
};
