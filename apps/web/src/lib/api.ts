import type {
  AreaStorage,
  AreaStorageConfig,
  AreaStorageState,
  AskRequest,
  AuthState,
  BriefingCadence,
  CreateRunnerRequest,
  RunnerProbeResult,
  RunnerRecord,
  UpdateRunnerRequest,
  ChecksSummary,
  CommentRecord,
  CreateUserRequest,
  DocRecord,
  DocSearchHit,
  HistorySegment,
  InstanceBranding,
  IssueRecord,
  LoginResponse,
  ModelCatalog,
  ModelCatalogProvider,
  NotificationRecord,
  GitHubAccountRecord,
  GitHubAccountScope,
  GitHubPurpose,
  MoxxyStatus,
  PipelineRecord,
  PipelineRunRecord,
  PrRecord,
  PrReviewResult,
  ProposalRecord,
  ReportRecord,
  RepoDocFile,
  RepoRecord,
  Role,
  RunRecord,
  SpecRecord,
  SavePipelineRequest,
  SaveStepDefinitionRequest,
  SessionInfo,
  SkillFile,
  SpaServerMessage,
  StepDefinitionRecord,
  TriageResult,
  UpdateUserRequest,
  UserRecord,
  WebhookInfo,
  WebhookTunnelState,
  WorkspaceMember,
  WorkspaceMemberCandidate,
  WorkspaceMetrics,
  WorkspaceReviews,
  WorkspaceRecord,
  WorkspaceVisibility,
} from '@companion/contract';

/**
 * REST + WebSocket client for companiond. Auth is a login session token
 * (localStorage); every 401 clears it and notifies the auth layer so the app
 * falls back to the login screen. One WS connection app-wide; pages subscribe
 * to the multiplexed stream and filter by tag.
 */

const TOKEN_KEY = 'companion.session';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

// Auth-state listeners (the AuthProvider subscribes).
type AuthListener = () => void;
const authListeners = new Set<AuthListener>();

export function onAuthChanged(fn: AuthListener): () => void {
  authListeners.add(fn);
  return () => authListeners.delete(fn);
}

function emitAuthChanged(): void {
  for (const fn of [...authListeners]) fn();
}

/** Re-resolve the session (e.g. after editing your own display name). */
export function refreshAuth(): void {
  emitAuthChanged();
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  if (res.status === 401) {
    setToken(null);
    disconnectWs();
    emitAuthChanged();
    throw new ApiError('session expired — sign in again', 401);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(body.error ?? `${res.status} ${res.statusText}`, res.status);
  }
  return (await res.json()) as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
const put = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
const patch = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
const del = <T>(path: string) => request<T>(path, { method: 'DELETE' });

/** Server-side paging/search window for list endpoints. */
export interface PageQuery {
  q?: string;
  repo?: string;
  limit?: number;
  offset?: number;
}

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') sp.set(k, String(v));
  }
  const str = sp.toString();
  return str ? `?${str}` : '';
}

// ---------- auth ---------------------------------------------------------------

async function publicPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const parsed = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(parsed.error ?? `${res.status} ${res.statusText}`, res.status);
  }
  return (await res.json()) as T;
}

export const auth = {
  /** Public bootstrap: is first-boot onboarding still pending? */
  async state(): Promise<AuthState> {
    const res = await fetch('/api/auth/state');
    if (!res.ok) throw new ApiError('companiond unreachable', res.status);
    return (await res.json()) as AuthState;
  },

  /** First-boot onboarding: create the admin account and sign in. */
  async setup(username: string, email: string, password: string): Promise<LoginResponse> {
    const session = await publicPost<LoginResponse>('/api/auth/setup', { username, email, password });
    setToken(session.token);
    emitAuthChanged();
    return session;
  },

  async login(username: string, password: string): Promise<LoginResponse> {
    const session = await publicPost<LoginResponse>('/api/auth/login', { username, password });
    setToken(session.token);
    emitAuthChanged();
    return session;
  },

  async logout(): Promise<void> {
    await post('/api/auth/logout').catch(() => undefined);
    setToken(null);
    disconnectWs();
    emitAuthChanged();
  },

  me: () => request<SessionInfo>('/api/auth/me'),
  hasSession: (): boolean => getToken() !== null,
};

// ---------- api ------------------------------------------------------------------

export const api = {
  status: () => request<MoxxyStatus>('/api/status'),

  // users (admin)
  listUsers: (opts?: PageQuery & { role?: Role }) =>
    request<{ users: UserRecord[]; total: number }>(`/api/users${qs({ ...opts })}`),
  createUser: (body: CreateUserRequest) => post<{ user: UserRecord }>('/api/users', body),
  updateUser: (username: string, body: UpdateUserRequest) =>
    patch<{ user: UserRecord }>(`/api/users/${username}`, body),
  deleteUser: (username: string) => del<{ ok: true }>(`/api/users/${username}`),
  importProviders: () => post<{ imported: string[]; missing: string[] }>('/api/moxxy/import-providers'),
  setGithubToken: (t: string) => post<{ login: string }>('/api/settings/github', { token: t }),
  setBranding: (branding: { name: string | null; logo: string | null }) =>
    put<{ branding: InstanceBranding }>('/api/settings/branding', branding),

  // workspaces
  listWorkspaces: () => request<{ workspaces: WorkspaceRecord[] }>('/api/workspaces'),
  createWorkspace: (name: string, opts?: { description?: string; visibility?: WorkspaceVisibility }) =>
    post<{ workspace: WorkspaceRecord }>('/api/workspaces', { name, ...opts }),
  updateWorkspace: (
    id: string,
    fields: { name?: string; description?: string; visibility?: WorkspaceVisibility },
  ) => patch<{ workspace: WorkspaceRecord }>(`/api/workspaces/${id}`, fields),
  deleteWorkspace: (id: string) => del<{ ok: true }>(`/api/workspaces/${id}`),
  // private-workspace membership
  listWorkspaceMembers: (id: string) =>
    request<{ members: WorkspaceMember[] }>(`/api/workspaces/${id}/members`),
  workspaceMemberCandidates: (id: string, q: string) =>
    request<{ candidates: WorkspaceMemberCandidate[] }>(
      `/api/workspaces/${id}/member-candidates${qs({ q: q || undefined })}`,
    ),
  addWorkspaceMember: (id: string, username: string) =>
    post<{ members: WorkspaceMember[] }>(`/api/workspaces/${id}/members`, { username }),
  removeWorkspaceMember: (id: string, username: string) =>
    del<{ members: WorkspaceMember[] }>(`/api/workspaces/${id}/members/${encodeURIComponent(username)}`),
  workspaceRepos: (id: string) => request<{ repos: RepoRecord[] }>(`/api/workspaces/${id}/repos`),
  workspaceIssues: (
    id: string,
    state?: 'open' | 'closed',
    page?: PageQuery & { author?: string; assignee?: string; label?: string },
  ) =>
    request<{
      issues: IssueRecord[];
      total: number;
      counts: { open: number; closed: number };
      facets: { authors: string[]; assignees: string[]; labels: string[] };
    }>(`/api/workspaces/${id}/issues${qs({ state, ...page })}`),
  workspacePrs: (
    id: string,
    state?: 'open' | 'merged' | 'closed',
    page?: PageQuery & { author?: string; assignee?: string; decision?: string; draft?: string },
  ) =>
    request<{
      prs: PrRecord[];
      total: number;
      counts: { open: number; merged: number; closed: number };
      facets: { authors: string[]; assignees: string[] };
    }>(`/api/workspaces/${id}/prs${qs({ state, ...page })}`),
  workspaceProposals: (id: string) =>
    request<{ proposals: ProposalRecord[] }>(`/api/workspaces/${id}/proposals`),
  workspaceMetrics: (id: string) => request<{ metrics: WorkspaceMetrics }>(`/api/workspaces/${id}/metrics`),
  workspaceReviews: (id: string) => request<WorkspaceReviews>(`/api/workspaces/${id}/reviews`),
  workspacePipelines: (id: string) =>
    request<{ pipelines: PipelineRecord[]; stepDefinitions: StepDefinitionRecord[] }>(
      `/api/workspaces/${id}/pipelines`,
    ),
  workspacePipelineRuns: (id: string) =>
    request<{ runs: PipelineRunRecord[] }>(`/api/workspaces/${id}/pipeline-runs`),

  // pipelines + step library
  createPipeline: (workspaceId: string, body: SavePipelineRequest) =>
    post<{ pipeline: PipelineRecord }>(`/api/workspaces/${workspaceId}/pipelines`, body),
  updatePipeline: (id: string, body: SavePipelineRequest) =>
    put<{ pipeline: PipelineRecord }>(`/api/pipelines/${id}`, body),
  deletePipeline: (id: string) => del<{ ok: true }>(`/api/pipelines/${id}`),
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
  prPipelineRuns: (repo: string, prNumber: number) =>
    request<{ runs: PipelineRunRecord[] }>(`/api/repos/${repo}/prs/${prNumber}/pipeline-runs`),
  pipelineRun: (id: string) => request<{ run: PipelineRunRecord }>(`/api/pipeline-runs/${id}`),

  // repos
  listRepos: () => request<{ repos: RepoRecord[] }>('/api/repos'),
  addRepo: (fullName: string, workspaceId: string) =>
    post<{ repo: RepoRecord }>('/api/repos', { fullName, workspaceId }),
  removeRepo: (fullName: string) => del<{ ok: true }>(`/api/repos/${fullName}`),
  moveRepo: (fullName: string, workspaceId: string) =>
    post<{ repo: RepoRecord }>(`/api/repos/${fullName}/workspace`, { workspaceId }),
  syncRepo: (fullName: string) => post<{ issues: number; prs: number }>(`/api/repos/${fullName}/sync`),
  setAutomation: (
    fullName: string,
    fields: { autoTriage?: boolean; digest?: boolean; staleSweep?: boolean; prGate?: boolean; autoMerge?: boolean },
  ) => post<{ repo: RepoRecord }>(`/api/repos/${fullName}/automation`, fields),
  enableWebhook: (fullName: string) => post<WebhookInfo>(`/api/repos/${fullName}/webhook`),
  disableWebhook: (fullName: string) => del<{ ok: true }>(`/api/repos/${fullName}/webhook`),
  /** Read-only: never (re-)enables the receiver. */
  getWebhook: (fullName: string) => request<{ webhook: WebhookInfo | null }>(`/api/repos/${fullName}/webhook`),
  webhookTunnel: () => request<WebhookTunnelState>('/api/webhooks/tunnel'),
  setWebhookTunnel: (enabled: boolean) => put<WebhookTunnelState>('/api/webhooks/tunnel', { enabled }),
  digestNow: (fullName: string) => post<{ ok: true }>(`/api/repos/${fullName}/digest-now`),
  staleNow: (fullName: string) => post<{ ok: true }>(`/api/repos/${fullName}/stale-now`),

  // workspace briefing
  getBriefing: (workspaceId: string) => request<{ cadence: BriefingCadence }>(`/api/workspaces/${workspaceId}/briefing`),
  setBriefing: (workspaceId: string, cadence: BriefingCadence) =>
    put<{ cadence: BriefingCadence }>(`/api/workspaces/${workspaceId}/briefing`, { cadence }),
  briefingNow: (workspaceId: string) => post<{ ok: true }>(`/api/workspaces/${workspaceId}/briefing-now`),

  // issues + prs
  listIssues: (fullName: string, state?: 'open' | 'closed') =>
    request<{ issues: IssueRecord[] }>(`/api/repos/${fullName}/issues${state ? `?state=${state}` : ''}`),
  getIssue: (fullName: string, number: number) =>
    request<{ issue: IssueRecord; triage: TriageResult | null }>(`/api/repos/${fullName}/issues/${number}`),
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
  analyzeFailedChecks: (fullName: string, number: number) =>
    post<{ queued: true }>(`/api/repos/${fullName}/prs/${number}/checks/analyze`),
  fixChecks: (fullName: string, number: number) =>
    post<{ run: RunRecord }>(`/api/repos/${fullName}/prs/${number}/fix-checks`),
  addressReviews: (fullName: string, number: number) =>
    post<{ run: RunRecord }>(`/api/repos/${fullName}/prs/${number}/address-reviews`),
  prComments: (fullName: string, number: number) =>
    request<{ comments: CommentRecord[] }>(`/api/repos/${fullName}/prs/${number}/comments`),
  commentPr: (fullName: string, number: number, body: string) =>
    post<{ url: string }>(`/api/repos/${fullName}/prs/${number}/comment`, { body }),
  issueComments: (fullName: string, number: number) =>
    request<{ comments: CommentRecord[] }>(`/api/repos/${fullName}/issues/${number}/comments`),
  commentIssue: (fullName: string, number: number, body: string) =>
    post<{ url: string }>(`/api/repos/${fullName}/issues/${number}/comment`, { body }),
  setIssueState: (fullName: string, number: number, state: 'open' | 'closed') =>
    post<{ ok: true }>(`/api/repos/${fullName}/issues/${number}/state`, { state }),
  analyzePr: (fullName: string, number: number) =>
    post<{ queued: true }>(`/api/repos/${fullName}/prs/${number}/analyze`),
  mergePr: (fullName: string, number: number, method: 'merge' | 'squash' | 'rebase') =>
    post<{ ok: true }>(`/api/repos/${fullName}/prs/${number}/merge`, { method }),
  closePr: (fullName: string, number: number) => post<{ ok: true }>(`/api/repos/${fullName}/prs/${number}/close`),
  applyPrReview: (id: string, accountId?: string) =>
    post<{ ok: true }>(`/api/pr-reviews/${id}/apply${accountId ? `?account=${encodeURIComponent(accountId)}` : ''}`),
  dismissPrReview: (id: string) => post<{ ok: true }>(`/api/pr-reviews/${id}/dismiss`),
  triageIssue: (fullName: string, number: number) =>
    post<{ queued: true }>(`/api/repos/${fullName}/issues/${number}/triage`),
  fixIssue: (fullName: string, number: number) =>
    post<{ run: RunRecord }>(`/api/repos/${fullName}/issues/${number}/fix`),
  applyTriage: (id: string, comment: boolean, accountId?: string) =>
    post<{ ok: true }>(`/api/triage/${id}/apply${accountId ? `?account=${accountId}` : ''}`, { comment }),
  dismissTriage: (id: string) => post<{ ok: true }>(`/api/triage/${id}/dismiss`),

  // proposals
  listProposals: () => request<{ proposals: ProposalRecord[] }>('/api/proposals'),
  createProposal: (repo: string, title: string, body: string) =>
    post<{ proposal: ProposalRecord }>('/api/proposals', { repo, title, body }),
  analyzeProposal: (id: string) => post<{ queued: true }>(`/api/proposals/${id}/analyze`),
  approveProposal: (id: string) => post<{ proposal: ProposalRecord }>(`/api/proposals/${id}/approve`),
  finishProposal: (id: string) => post<{ proposal: ProposalRecord }>(`/api/proposals/${id}/finish`),
  rejectProposal: (id: string) => post<{ ok: true }>(`/api/proposals/${id}/reject`),

  // specifications
  workspaceSpecs: (id: string) => request<{ specs: SpecRecord[] }>(`/api/workspaces/${id}/specs`),
  specsConfig: (id: string) => request<AreaStorageState>(`/api/workspaces/${id}/specs-config`),
  saveSpecsConfig: (id: string, dir: string | null) =>
    put<{ config: AreaStorageConfig; imported: number }>(`/api/workspaces/${id}/specs-config`, { dir }),
  getSpec: (id: string) => request<{ spec: SpecRecord }>(`/api/specs/${id}`),
  createSpec: (repo: string, title: string, content: string, storage?: AreaStorage) =>
    post<{ spec: SpecRecord }>('/api/specs', { repo, title, content, storage }),
  updateSpec: (id: string, fields: { title?: string; content?: string }) =>
    patch<{ spec: SpecRecord }>(`/api/specs/${id}`, fields),
  deleteSpec: (id: string) => del<{ ok: true }>(`/api/specs/${id}`),
  generateSpec: (repo: string, instructions: string, storage?: AreaStorage) =>
    post<{ queued: true }>('/api/specs/generate', { repo, instructions, storage }),
  dismissSpecDrift: (id: string) => post<{ ok: true }>(`/api/specs/${id}/dismiss-drift`),
  captureSpecFromProposal: (proposalId: string) =>
    post<{ queued: true }>(`/api/proposals/${proposalId}/capture-spec`),
  createFeatureFromSpec: (id: string, fields: { title?: string; notes?: string }) =>
    post<{ proposal: ProposalRecord }>(`/api/specs/${id}/create-feature`, fields),

  // documentation
  workspaceDocs: (id: string) => request<{ docs: DocRecord[] }>(`/api/workspaces/${id}/docs`),
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

  // AI Help assistant (per-user conversation run)
  assistant: () => request<{ run: RunRecord | null; pendingAsks: AskRequest[] }>('/api/assistant'),
  assistantSession: () => post<{ run: RunRecord; pendingAsks: AskRequest[] }>('/api/assistant/session'),
  assistantMessage: (text: string, repo?: string) =>
    post<{ turnId: string }>('/api/assistant/message', { text, repo }),
  assistantHistory: (before: number | null, limit = 300) =>
    request<HistorySegment>(`/api/assistant/history?limit=${limit}${before === null ? '' : `&before=${before}`}`),
  assistantAsk: (requestId: string, response: Record<string, unknown>) =>
    post<{ ok: true }>('/api/assistant/ask', { requestId, response }),
  assistantAbort: () => post<{ ok: true }>('/api/assistant/abort'),
  assistantReset: () => post<{ ok: true }>('/api/assistant/reset'),

  // model pins (per action kind)
  getModelPins: () =>
    request<{ pins: Record<string, string | null>; defaultModel: string }>('/api/settings/model-pins'),
  setModelPins: (pins: Record<string, string | null>) =>
    put<{ pins: Record<string, string | null> }>('/api/settings/model-pins', { pins }),

  // providers on/off
  getModelsCatalog: () =>
    request<{ providers: ModelCatalogProvider[]; defaultModel: string; fresh: boolean }>('/api/models-catalog'),
  getProviderSettings: () =>
    request<{ providers: Array<{ name: string; enabled: boolean }>; disabledModels: string[] }>(
      '/api/settings/providers',
    ),
  setProviderSettings: (disabledProviders: string[], disabledModels: string[]) =>
    put<{ ok: true }>('/api/settings/providers', { disabledProviders, disabledModels }),

  // GitHub accounts
  listGithubAccounts: () => request<{ accounts: GitHubAccountRecord[] }>('/api/github/accounts'),
  addGithubAccount: (
    token: string,
    purposes: readonly GitHubPurpose[],
    scope: GitHubAccountScope = 'shared',
    workspaceIds: readonly string[] = [],
    shared = false,
  ) => post<{ account: GitHubAccountRecord }>('/api/github/accounts', { token, purposes, scope, workspaceIds, shared }),
  updateGithubAccount: (
    id: string,
    fields: { purposes?: readonly GitHubPurpose[]; scope?: GitHubAccountScope; workspaceIds?: readonly string[] },
  ) => patch<{ account: GitHubAccountRecord }>(`/api/github/accounts/${id}`, fields),
  removeGithubAccount: (id: string) => del<{ ok: true }>(`/api/github/accounts/${id}`),
  setRepoGithubAccount: (fullName: string, accountId: string | null) =>
    patch<{ repo: RepoRecord }>(`/api/repos/${fullName}/github-account`, { accountId }),
  setRepoRunner: (fullName: string, runnerId: string | null) =>
    patch<{ repo: RepoRecord }>(`/api/repos/${fullName}/runner`, { runnerId }),

  // runners (execution machines)
  listRunners: () => request<{ runners: RunnerRecord[] }>('/api/runners'),
  createRunner: (body: CreateRunnerRequest) => post<{ runner: RunnerRecord }>('/api/runners', body),
  updateRunner: (id: string, body: UpdateRunnerRequest) =>
    patch<{ runner: RunnerRecord }>(`/api/runners/${id}`, body),
  deleteRunner: (id: string) => del<{ ok: true }>(`/api/runners/${id}`),
  probeRunner: (id: string) => post<RunnerProbeResult>(`/api/runners/${id}/probe`),

  // notifications
  listNotifications: (workspaceId?: string) =>
    request<{ notifications: NotificationRecord[] }>(
      `/api/notifications${workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : ''}`,
    ),
  markNotificationRead: (id: string) => post<{ ok: true }>(`/api/notifications/${id}/read`),
  markAllNotificationsRead: (workspaceId?: string) =>
    post<{ ok: true }>(`/api/notifications/read-all${workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : ''}`),

  // AI generation (bounded companion runner turns)
  generateSkill: (instructions: string) =>
    post<{ draft: { name: string; content: string } }>('/api/skills/generate', { instructions }),
  generateStepDefinition: (workspaceId: string, instructions: string) =>
    post<{ stepDefinition: StepDefinitionRecord }>(`/api/workspaces/${workspaceId}/step-definitions/generate`, {
      instructions,
    }),
  generatePipeline: (workspaceId: string, instructions: string) =>
    post<{ pipeline: PipelineRecord }>(`/api/workspaces/${workspaceId}/pipelines/generate`, { instructions }),

  // reports + skills
  listReports: () => request<{ reports: ReportRecord[] }>('/api/reports'),
  listSkills: () => request<{ skills: SkillFile[] }>('/api/skills'),
  saveSkill: (name: string, content: string) => put<{ skill: SkillFile }>(`/api/skills/${name}`, { content }),
  deleteSkill: (name: string) => del<{ ok: true }>(`/api/skills/${name}`),

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
};

// ---------- live stream -------------------------------------------------------

export type WsState = 'connected' | 'connecting' | 'offline';

type Listener = (msg: SpaServerMessage) => void;
type StateListener = (state: WsState) => void;
const listeners = new Set<Listener>();
const stateListeners = new Set<StateListener>();
let ws: WebSocket | null = null;
let backoff = 500;
let wsState: WsState = 'offline';

export function getWsState(): WsState {
  return wsState;
}

export function onWsState(fn: StateListener): () => void {
  stateListeners.add(fn);
  fn(wsState);
  return () => stateListeners.delete(fn);
}

function setWsState(state: WsState): void {
  wsState = state;
  for (const fn of [...stateListeners]) fn(state);
}

export function onServerMessage(fn: Listener): () => void {
  listeners.add(fn);
  connectWs();
  return () => listeners.delete(fn);
}

export function connectWs(): void {
  if (!getToken()) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  setWsState('connecting');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(getToken() ?? '')}`);
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(String(ev.data)) as SpaServerMessage;
      for (const fn of [...listeners]) fn(msg);
    } catch {
      // tolerate garbage
    }
  };
  ws.onopen = () => {
    backoff = 500;
    setWsState('connected');
  };
  ws.onclose = () => {
    ws = null;
    setWsState('offline');
    if (getToken()) {
      setTimeout(() => connectWs(), backoff);
      backoff = Math.min(backoff * 2, 10_000);
    }
  };
}

function disconnectWs(): void {
  const socket = ws;
  ws = null;
  socket?.close();
  setWsState('offline');
}
