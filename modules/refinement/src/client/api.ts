import { del, patch, post, put, request } from '@moxxy/companion-sdk/client';
import type {
  RefineContextOptions,
  RefineItemRecord,
  RefineItemUpdate,
  RefineMethodDraft,
  RefineMethodRecord,
  RefinementListEntry,
  RefinementRecord,
} from '../contract/index.js';

export interface RefinementDetail {
  readonly refinement: RefinementRecord;
  readonly items: RefineItemRecord[];
  /** The refinement's own workspace (via its repo) — methods resolve against THIS, not the switcher's. */
  readonly workspaceId: string | null;
}

export const refinementApi = {
  list: (workspaceId: string) =>
    request<{ refinements: RefinementListEntry[] }>(`/api/workspaces/${workspaceId}/refinements`),
  create: (input: { workspaceId: string; repo: string; branch?: string; title: string; story: string }) =>
    post<{ refinement: RefinementRecord }>('/api/refinements', input),
  get: (id: string) => request<RefinementDetail>(`/api/refinements/${id}`),
  update: (id: string, fields: { title?: string; story?: string; branch?: string }) =>
    put<{ refinement: RefinementRecord }>(`/api/refinements/${id}`, fields),
  remove: (id: string) => del<{ ok: true }>(`/api/refinements/${id}`),
  decompose: (id: string, body: { methodId: string; specIds: string[]; docIds: string[] }) =>
    post<{ queued: true }>(`/api/refinements/${id}/decompose`, body),
  contextOptions: (id: string) => request<RefineContextOptions>(`/api/refinements/${id}/context-options`),
  importItem: (id: string, itemId: string, queue: boolean, targetBranch?: string) =>
    post<{ item: RefineItemRecord }>(`/api/refinements/${id}/items/${itemId}/import`, { queue, targetBranch }),
  dismissItem: (id: string, itemId: string) =>
    post<{ item: RefineItemRecord }>(`/api/refinements/${id}/items/${itemId}/dismiss`),
  updateItem: (id: string, itemId: string, fields: RefineItemUpdate) =>
    patch<{ item: RefineItemRecord }>(`/api/refinements/${id}/items/${itemId}`, fields),
  moveItem: (id: string, itemId: string, direction: 'up' | 'down') =>
    post<{ items: RefineItemRecord[] }>(`/api/refinements/${id}/items/${itemId}/move`, { direction }),
  mergeItems: (id: string, itemIds: string[], fields: { title?: string; description?: string; acceptance?: string; priority?: 0 | 1 | 2 | 3 }) =>
    post<{ item: RefineItemRecord }>(`/api/refinements/${id}/items/merge`, { itemIds, ...fields }),
  importAll: (id: string, queue: boolean, targetBranch?: string) =>
    post<{ imported: number }>(`/api/refinements/${id}/import-all`, { queue, targetBranch }),
  methods: (workspaceId: string) =>
    request<{ methods: RefineMethodRecord[] }>(`/api/workspaces/${workspaceId}/refine-methods`),
  saveMethod: (workspaceId: string, fields: { name: string; description: string; instructions: string }) =>
    post<{ method: RefineMethodRecord }>(`/api/workspaces/${workspaceId}/refine-methods`, fields),
  generateMethod: (workspaceId: string, prompt: string) =>
    post<{ draft: RefineMethodDraft }>(`/api/workspaces/${workspaceId}/refine-methods/generate`, { prompt }),
  updateMethod: (id: string, fields: { name?: string; description?: string; instructions?: string }) =>
    put<{ method: RefineMethodRecord }>(`/api/refine-methods/${id}`, fields),
  deleteMethod: (id: string) => del<{ ok: true }>(`/api/refine-methods/${id}`),
};
