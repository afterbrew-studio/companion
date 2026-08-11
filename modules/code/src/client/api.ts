import { del, patch, post, put, qs, request, type PageQuery } from '@moxxy/companion-sdk/client';
import type { RunRecord } from '@companion/module-operate/contract';
import type { AskRequest, MoxxyEvent } from '@moxxy/companion-sdk/agents';
import type { ReportRecord } from '@companion/module-workspace/contract';
import type {
  AgentQuality,
  ChecksSummary,
  CommentRecord,
  GitHubAccountRecord,
  GitHubAccountScope,
  GitHubPurpose,
  ImportPreview,
  IssueListRecord,
  IssueRecord,
  PipelineExport,
  PipelineRecord,
  PipelineRunRecord,
  PipelineStepLog,
  PrFileChangesPage,
  PrListRecord,
  PrRecord,
  PrReviewResult,
  FindingSeverity,
  FindingState,
  ReviewFinding,
  ReviewOptions,
  ReviewPostMode,
  RepoAccountOption,
  RepoCandidate,
  RepoBranchRecord,
  RepoAgentContext,
  RepoRecord,
  SavePipelineRequest,
  SaveStepDefinitionRequest,
  StepDefinitionRecord,
  WorkspaceSyncResult,
  TriageResult,
} from '../contract/index.js';

/**
 * module-code's REST surface, carved from the legacy `lib/api.ts`: repositories
 * + the GitHub account registry, the workspace-scoped issue/PR/pipeline feeds,
 * issue triage + fixes, PR reviews/checks/lifecycle, and the pipeline + step
 * library CRUD. HTTP + token plumbing lives in `@moxxy/companion-core/client`.
 */

export const codeApi = {
  setVerifyCommand: (fullName: string, command: string) =>
    put<{ repo: RepoRecord }>(`/api/repos/${fullName}/verify-command`, { command }),
  agentQuality: (workspaceId: string, days: number) =>
    request<AgentQuality>(`/api/workspaces/${workspaceId}/agent-quality?days=${days}`),
  // repos
  listRepos: () => request<{ repos: RepoRecord[] }>('/api/repos'),
  repoAgentContext: (fullName: string, refresh = false) =>
    request<{ context: RepoAgentContext }>(
      `/api/repos/${fullName}/agent-context${refresh ? '?refresh=1' : ''}`,
    ),
  repoBranches: (fullName: string, workspaceId: string) =>
    request<{ branches: RepoBranchRecord[]; defaultBranch: string }>(
      `/api/repos/${fullName}/branches?workspaceId=${encodeURIComponent(workspaceId)}`,
    ),
  addRepo: (fullName: string, workspaceId: string) =>
    post<{ repo: RepoRecord }>('/api/repos', { fullName, workspaceId }),
  /** Repos the reachable GitHub accounts can see — feeds the add-repo picker. */
  repoCandidates: (workspaceId: string) =>
    request<{ candidates: RepoCandidate[] }>(`/api/github/repo-candidates?workspaceId=${encodeURIComponent(workspaceId)}`),
  removeRepo: (fullName: string, workspaceId: string) =>
    del<{ ok: true }>(`/api/repos/${fullName}?workspaceId=${encodeURIComponent(workspaceId)}`),
  moveRepo: (fullName: string, fromWorkspaceId: string, workspaceId: string) =>
    post<{ repo: RepoRecord }>(`/api/repos/${fullName}/workspace`, { fromWorkspaceId, workspaceId }),
  syncRepo: (fullName: string) => post<{ issues: number; prs: number }>(`/api/repos/${fullName}/sync`),
  setRepoRunner: (fullName: string, runnerId: string | null) =>
    patch<{ repo: RepoRecord }>(`/api/repos/${fullName}/runner`, { runnerId }),
  /** My accounts eligible for this repo, each graded by what it may do there. */
  repoAccounts: (fullName: string) =>
    request<{ accounts: RepoAccountOption[] }>(`/api/repos/${fullName}/accounts`),
  setRepoAccount: (fullName: string, accountId: string | null) =>
    put<{ accounts: RepoAccountOption[] }>(`/api/repos/${fullName}/account`, { accountId }),

  // workspace-scoped feeds
  workspaceRepos: (id: string) => request<{ repos: RepoRecord[] }>(`/api/workspaces/${id}/repos`),
  refreshWorkspace: (id: string) => post<WorkspaceSyncResult>(`/api/workspaces/${id}/sync`),
  workspaceIssues: (
    id: string,
    state?: 'open' | 'closed',
    page?: PageQuery & { author?: string; assignee?: string; label?: string; triage?: string },
  ) =>
    request<{
      issues: IssueListRecord[];
      total: number;
      counts: { open: number; closed: number };
      facets: { authors: string[]; assignees: string[]; labels: string[] };
    }>(`/api/workspaces/${id}/issues${qs({ state, ...page })}`),
  workspacePrs: (
    id: string,
    state?: 'open' | 'merged' | 'closed',
    page?: PageQuery & { author?: string; assignee?: string; label?: string; decision?: string; draft?: string; review?: string },
  ) =>
    request<{
      prs: PrListRecord[];
      total: number;
      counts: { open: number; merged: number; closed: number };
      facets: { authors: string[]; assignees: string[]; labels: string[] };
    }>(`/api/workspaces/${id}/prs${qs({ state, ...page })}`),
  workspacePipelines: (id: string) =>
    request<{ pipelines: PipelineRecord[]; stepDefinitions: StepDefinitionRecord[] }>(
      `/api/workspaces/${id}/pipelines`,
    ),
  workspacePipelineRuns: (id: string) =>
    request<{ runs: PipelineRunRecord[] }>(`/api/workspaces/${id}/pipeline-runs`),

  // issues + triage
  getIssue: (fullName: string, number: number) =>
    request<{ issue: IssueRecord; triage: TriageResult | null }>(`/api/repos/${fullName}/issues/${number}`),
  issueComments: (fullName: string, number: number) =>
    request<{ comments: CommentRecord[] }>(`/api/repos/${fullName}/issues/${number}/comments`),
  commentIssue: (fullName: string, number: number, body: string) =>
    post<{ url: string }>(`/api/repos/${fullName}/issues/${number}/comment`, { body }),
  setIssueState: (fullName: string, number: number, state: 'open' | 'closed') =>
    post<{ ok: true }>(`/api/repos/${fullName}/issues/${number}/state`, { state }),
  triageIssue: (fullName: string, number: number) =>
    post<{ queued: true }>(`/api/repos/${fullName}/issues/${number}/triage`),
  fixIssue: (fullName: string, number: number) =>
    post<{ run: RunRecord }>(`/api/repos/${fullName}/issues/${number}/fix`),
  applyTriage: (id: string, comment: boolean, accountId?: string) =>
    post<{ ok: true }>(`/api/triage/${id}/apply${accountId ? `?account=${accountId}` : ''}`, { comment }),
  dismissTriage: (id: string) => post<{ ok: true }>(`/api/triage/${id}/dismiss`),

  // prs
  listPrs: (fullName: string) => request<{ prs: PrRecord[] }>(`/api/repos/${fullName}/prs`),
  getPr: (fullName: string, number: number) =>
    request<{
      pr: PrRecord;
      review: PrReviewResult | null;
      pipelineRuns: PipelineRunRecord[];
      ciAnalysis: ReportRecord | null;
    }>(`/api/repos/${fullName}/prs/${number}`),
  prChecks: (fullName: string, number: number) =>
    request<{ checks: ChecksSummary }>(`/api/repos/${fullName}/prs/${number}/checks`),
  prFiles: (fullName: string, number: number, page = 1) =>
    request<PrFileChangesPage>(`/api/repos/${fullName}/prs/${number}/files?page=${page}`),
  analyzeFailedChecks: (fullName: string, number: number) =>
    post<{ queued: true }>(`/api/repos/${fullName}/prs/${number}/checks/analyze`),
  fixChecks: (fullName: string, number: number) =>
    post<{ run: RunRecord }>(`/api/repos/${fullName}/prs/${number}/fix-checks`),
  addressReviews: (fullName: string, number: number) =>
    post<{ run: RunRecord }>(`/api/repos/${fullName}/prs/${number}/address-reviews`),
  resolveConflicts: (fullName: string, number: number) =>
    post<{ run: RunRecord }>(`/api/repos/${fullName}/prs/${number}/resolve-conflicts`),
  runPrAgent: (fullName: string, number: number, instructions: string) =>
    post<{ run: RunRecord }>(`/api/repos/${fullName}/prs/${number}/agent`, { instructions }),
  prComments: (fullName: string, number: number) =>
    request<{ comments: CommentRecord[] }>(`/api/repos/${fullName}/prs/${number}/comments`),
  commentPr: (fullName: string, number: number, body: string) =>
    post<{ url: string }>(`/api/repos/${fullName}/prs/${number}/comment`, { body }),
  analyzePr: (fullName: string, number: number, opts?: ReviewOptions) =>
    post<{ queued: true }>(`/api/repos/${fullName}/prs/${number}/analyze`, opts ?? {}),
  mergePr: (fullName: string, number: number, method: 'merge' | 'squash' | 'rebase') =>
    post<{ ok: true }>(`/api/repos/${fullName}/prs/${number}/merge`, { method }),
  closePr: (fullName: string, number: number) => post<{ ok: true }>(`/api/repos/${fullName}/prs/${number}/close`),
  approvePipelineStep: (runId: string, stepIndex: number, approved: boolean) =>
    post<{ ok: true }>(`/api/pipeline-runs/${runId}/steps/${stepIndex}/approve`, { approved }),
  cancelPipelineRun: (runId: string) =>
    post<{ run: PipelineRunRecord }>(`/api/pipeline-runs/${runId}/cancel`),
  pipelineStepLog: (runId: string, stepIndex: number, afterSequence = 0) =>
    request<{ log: PipelineStepLog | null }>(
      `/api/pipeline-runs/${runId}/steps/${stepIndex}/log?after=${afterSequence}`,
    ),
  rerunChecks: (fullName: string, number: number, scope: 'failed' | 'all' = 'failed') =>
    post<{ restarted: number }>(`/api/repos/${fullName}/prs/${number}/rerun-checks`, { scope }),
  markPrReady: (fullName: string, number: number) =>
    post<{ ok: true }>(`/api/repos/${fullName}/prs/${number}/ready`),
  updatePrBranch: (fullName: string, number: number) =>
    post<{ ok: true }>(`/api/repos/${fullName}/prs/${number}/update-branch`),
  labelPr: (fullName: string, number: number, labels: string[]) =>
    post<{ ok: true }>(`/api/repos/${fullName}/prs/${number}/labels`, { labels }),
  labelIssue: (fullName: string, number: number, labels: string[]) =>
    post<{ ok: true }>(`/api/repos/${fullName}/issues/${number}/labels`, { labels }),
  applyPrReview: (
    id: string,
    accountId?: string,
    body: { findingIds?: readonly string[]; mode?: ReviewPostMode } = {},
  ) =>
    post<{ ok: true }>(
      `/api/pr-reviews/${id}/apply${accountId ? `?account=${encodeURIComponent(accountId)}` : ''}`,
      body,
    ),
  reviewChat: (id: string) =>
    request<{
      run: { id: string; live: boolean } | null;
      pendingAsks: AskRequest[];
      history: { events: MoxxyEvent[]; prevCursor: number | null };
    }>(`/api/pr-reviews/${id}/chat`),
  answerReviewChatAsk: (id: string, requestId: string, response: Record<string, unknown>) =>
    post<{ ok: true }>(`/api/pr-reviews/${id}/chat/ask`, { requestId, response }),
  askReviewChat: (id: string, findingId: string | null, text: string) =>
    post<{ turnId: string; runId: string }>(`/api/pr-reviews/${id}/chat`, { findingId, text }),
  prFileLines: (fullName: string, number: number, path: string, from: number, to: number) =>
    request<{ from: number; lines: string[] }>(
      `/api/repos/${fullName}/prs/${number}/file?path=${encodeURIComponent(path)}&from=${from}&to=${to}`,
    ),
  createReviewDraft: (fullName: string, number: number) =>
    post<{ review: PrReviewResult }>(`/api/repos/${fullName}/prs/${number}/review-draft`),
  addReviewFinding: (
    id: string,
    body: { file: string; side: 'LEFT' | 'RIGHT'; line: number; body: string; severity?: FindingSeverity },
  ) => post<{ finding: ReviewFinding }>(`/api/pr-reviews/${id}/findings`, body),
  updateReviewFinding: (
    id: string,
    body: { state?: FindingState; rejectionReason?: string; reason?: string; suggestion?: string },
  ) => patch<{ ok: true }>(`/api/pr-review-findings/${id}`, body),
  cancelPrReview: (id: string) => post<{ ok: true }>(`/api/pr-reviews/${id}/cancel`),
  dismissPrReview: (id: string) => post<{ ok: true }>(`/api/pr-reviews/${id}/dismiss`),

  // pipelines + step library
  createPipeline: (workspaceId: string, body: SavePipelineRequest) =>
    post<{ pipeline: PipelineRecord }>(`/api/workspaces/${workspaceId}/pipelines`, body),
  updatePipeline: (id: string, body: SavePipelineRequest) =>
    put<{ pipeline: PipelineRecord }>(`/api/pipelines/${id}`, body),
  deletePipeline: (id: string) => del<{ ok: true }>(`/api/pipelines/${id}`),
  exportPipeline: (id: string) => request<{ document: PipelineExport }>(`/api/pipelines/${id}/export`),
  previewPipelineImport: (workspaceId: string, document: unknown) =>
    post<{ preview: ImportPreview }>(`/api/workspaces/${workspaceId}/pipelines/import/preview`, { document }),
  importPipeline: (workspaceId: string, document: unknown, acknowledgeExecutables: boolean) =>
    post<{ pipeline: PipelineRecord }>(`/api/workspaces/${workspaceId}/pipelines/import`, {
      document,
      acknowledgeExecutables,
    }),
  createStepDefinition: (workspaceId: string, body: SaveStepDefinitionRequest) =>
    post<{ stepDefinition: StepDefinitionRecord }>(`/api/workspaces/${workspaceId}/step-definitions`, body),
  updateStepDefinition: (id: string, body: SaveStepDefinitionRequest) =>
    put<{ stepDefinition: StepDefinitionRecord }>(`/api/step-definitions/${id}`, body),
  deleteStepDefinition: (id: string) => del<{ ok: true }>(`/api/step-definitions/${id}`),
  runPipeline: (repo: string, prNumber: number, pipelineId: string) =>
    post<{ run: PipelineRunRecord }>(`/api/repos/${repo}/prs/${prNumber}/pipelines/${pipelineId}/run`),
  runPipelineOnIssue: (repo: string, issueNumber: number, pipelineId: string) =>
    post<{ run: PipelineRunRecord }>(`/api/repos/${repo}/issues/${issueNumber}/pipelines/${pipelineId}/run`),
  runPlatformPipeline: (repo: string, pipelineId: string) =>
    post<{ run: PipelineRunRecord }>(`/api/repos/${repo}/pipelines/${pipelineId}/run`),
  issuePipelineRuns: (repo: string, issueNumber: number) =>
    request<{ runs: PipelineRunRecord[] }>(`/api/repos/${repo}/issues/${issueNumber}/pipeline-runs`),
  pipelineRun: (id: string) => request<{ run: PipelineRunRecord }>(`/api/pipeline-runs/${id}`),

  // AI generation (bounded companion runner turns)
  generateStepDefinition: (workspaceId: string, instructions: string) =>
    post<{ stepDefinition: StepDefinitionRecord }>(`/api/workspaces/${workspaceId}/step-definitions/generate`, {
      instructions,
    }),
  generatePipeline: (workspaceId: string, instructions: string) =>
    post<{ pipeline: PipelineRecord }>(`/api/workspaces/${workspaceId}/pipelines/generate`, { instructions }),

  // GitHub accounts
  listGithubAccounts: () => request<{ accounts: GitHubAccountRecord[] }>('/api/github/accounts'),
  addGithubAccount: (
    token: string,
    purposes: readonly GitHubPurpose[],
    scope: GitHubAccountScope = 'all',
    workspaceIds: readonly string[] = [],
  ) => post<{ account: GitHubAccountRecord }>('/api/github/accounts', { token, purposes, scope, workspaceIds }),

  /** Connect a GitHub App installation instead of a personal token. */
  addGithubAppAccount: (
    app: { appId: string; installationId: string; privateKey: string },
    purposes: readonly GitHubPurpose[],
    scope: GitHubAccountScope,
    workspaceIds: readonly string[],
  ) => post<{ account: GitHubAccountRecord }>('/api/github/accounts/app', { ...app, purposes, scope, workspaceIds }),
  updateGithubAccount: (
    id: string,
    fields: { purposes?: readonly GitHubPurpose[]; scope?: GitHubAccountScope; workspaceIds?: readonly string[] },
  ) => patch<{ account: GitHubAccountRecord }>(`/api/github/accounts/${id}`, fields),
  removeGithubAccount: (id: string) => del<{ ok: true }>(`/api/github/accounts/${id}`),
};
