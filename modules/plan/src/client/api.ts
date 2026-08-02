import { del, patch, post, put, qs, request } from '@moxxy/companion-sdk/client';
import type {
  AreaStorage,
  AreaStorageConfig,
  AreaStorageState,
  DocListRecord,
  DocRecord,
  DocSearchHit,
  ProposalListRecord,
  ProposalRecord,
  RepoDocFile,
  SpecListRecord,
  SpecRecord,
} from '../contract/index.js';

/**
 * module-plan's REST surface, carved from the legacy `lib/api.ts`: the proposal
 * lifecycle (create → analyze → approve → finish / reject), the specification
 * library (CRUD, generation, drift, spec → feature), and the documentation
 * index (CRUD, retrieval search, repo import, generation) plus the per-area
 * storage config. HTTP + token plumbing lives in `@moxxy/companion-core/client`.
 */

export const planApi = {
  // proposals
  workspaceProposals: (
    id: string,
    page: { q?: string; repo?: string; status?: string; limit?: number; offset?: number } = {},
  ) => request<{ proposals: ProposalListRecord[]; total: number }>(`/api/workspaces/${id}/proposals${qs(page)}`),
  getProposal: (id: string) => request<{ proposal: ProposalRecord }>(`/api/proposals/${id}`),
  createProposal: (workspaceId: string, repo: string, title: string, body: string) =>
    post<{ proposal: ProposalRecord }>('/api/proposals', { workspaceId, repo, title, body }),
  analyzeProposal: (id: string) => post<{ queued: true }>(`/api/proposals/${id}/analyze`),
  updateProposal: (id: string, fields: { title?: string; body?: string }) =>
    patch<{ proposal: ProposalRecord }>(`/api/proposals/${id}`, fields),
  acceptProposalPlan: (id: string) => post<{ proposal: ProposalRecord }>(`/api/proposals/${id}/accept-plan`),
  approveProposal: (id: string) => post<{ proposal: ProposalRecord }>(`/api/proposals/${id}/approve`),
  finishProposal: (id: string) => post<{ proposal: ProposalRecord }>(`/api/proposals/${id}/finish`),
  rejectProposal: (id: string) => post<{ ok: true }>(`/api/proposals/${id}/reject`),

  // specifications
  workspaceSpecs: (
    id: string,
    page: { q?: string; repo?: string; status?: string; source?: string; storage?: string; limit?: number; offset?: number } = {},
  ) => request<{ specs: SpecListRecord[]; total: number }>(`/api/workspaces/${id}/specs${qs(page)}`),
  specsConfig: (id: string) => request<AreaStorageState>(`/api/workspaces/${id}/specs-config`),
  saveSpecsConfig: (id: string, dir: string | null) =>
    put<{ config: AreaStorageConfig; imported: number }>(`/api/workspaces/${id}/specs-config`, { dir }),
  getSpec: (id: string) => request<{ spec: SpecRecord }>(`/api/specs/${id}`),
  createSpec: (workspaceId: string, repo: string, title: string, content: string, storage?: AreaStorage) =>
    post<{ spec: SpecRecord }>('/api/specs', { workspaceId, repo, title, content, storage }),
  updateSpec: (id: string, fields: { title?: string; content?: string }) =>
    patch<{ spec: SpecRecord }>(`/api/specs/${id}`, fields),
  deleteSpec: (id: string) => del<{ ok: true }>(`/api/specs/${id}`),
  generateSpec: (workspaceId: string, repo: string, instructions: string, storage?: AreaStorage) =>
    post<{ queued: true }>('/api/specs/generate', { workspaceId, repo, instructions, storage }),
  dismissSpecDrift: (id: string) => post<{ ok: true }>(`/api/specs/${id}/dismiss-drift`),
  captureSpecFromProposal: (proposalId: string) =>
    post<{ queued: true }>(`/api/proposals/${proposalId}/capture-spec`),
  createFeatureFromSpec: (id: string, fields: { title?: string; notes?: string }) =>
    post<{ proposal: ProposalRecord }>(`/api/specs/${id}/create-feature`, fields),

  // documentation
  workspaceDocs: (
    id: string,
    page: { q?: string; repo?: string; source?: string; storage?: string; limit?: number; offset?: number } = {},
  ) => request<{ docs: DocListRecord[]; total: number }>(`/api/workspaces/${id}/docs${qs(page)}`),
  docsConfig: (id: string) => request<AreaStorageState>(`/api/workspaces/${id}/docs-config`),
  saveDocsConfig: (id: string, dir: string | null) =>
    put<{ config: AreaStorageConfig; imported: number }>(`/api/workspaces/${id}/docs-config`, { dir }),
  getDoc: (id: string) => request<{ doc: DocRecord }>(`/api/docs/${id}`),
  createDoc: (
    workspaceId: string,
    body: { repo?: string | null; title: string; content: string; storage?: AreaStorage },
  ) => post<{ doc: DocRecord }>(`/api/workspaces/${workspaceId}/docs`, body),
  updateDoc: (id: string, fields: { title?: string; content?: string; repo?: string | null }) =>
    patch<{ doc: DocRecord }>(`/api/docs/${id}`, fields),
  deleteDoc: (id: string) => del<{ ok: true }>(`/api/docs/${id}`),
  searchDocs: (workspaceId: string, q: string, limit = 8) =>
    request<{ hits: DocSearchHit[] }>(`/api/workspaces/${workspaceId}/docs/search${qs({ q, limit })}`),
  repoDocFiles: (repo: string) => request<{ files: RepoDocFile[] }>(`/api/repos/${repo}/doc-files`),
  importRepoDocs: (workspaceId: string, repo: string, paths: string[]) =>
    post<{ docs: DocRecord[] }>(`/api/workspaces/${workspaceId}/docs/import`, { repo, paths }),
  generateDoc: (workspaceId: string, body: { repo?: string; instructions: string; storage?: AreaStorage }) =>
    post<{ doc: DocRecord }>(`/api/workspaces/${workspaceId}/docs/generate`, body),
};
