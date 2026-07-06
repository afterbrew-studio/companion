import type {
  AskRequest,
  HistorySegment,
  IssueRecord,
  MoxxyStatus,
  PrRecord,
  PrReviewResult,
  ProposalRecord,
  ReportRecord,
  RepoRecord,
  RunRecord,
  SkillFile,
  SpaServerMessage,
  TriageResult,
  WebhookInfo,
} from '@companion/contract';

/**
 * REST + WebSocket client for companiond. One WS connection app-wide; pages
 * subscribe to the multiplexed stream and filter by tag.
 */

let token: string | null = null;

async function ensureToken(): Promise<string> {
  if (token) return token;
  const res = await fetch('/api/session');
  if (!res.ok) throw new Error('companiond unreachable');
  const body = (await res.json()) as { token: string };
  token = body.token;
  return token;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const t = await ensureToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      authorization: `Bearer ${t}`,
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

export const api = {
  status: () => request<MoxxyStatus>('/api/status'),
  importProviders: () => post<{ imported: string[]; missing: string[] }>('/api/moxxy/import-providers'),
  setGithubToken: (t: string) => post<{ login: string }>('/api/settings/github', { token: t }),

  // repos
  listRepos: () => request<{ repos: RepoRecord[] }>('/api/repos'),
  addRepo: (fullName: string) => post<{ repo: RepoRecord }>('/api/repos', { fullName }),
  removeRepo: (fullName: string) => request<{ ok: true }>(`/api/repos/${fullName}`, { method: 'DELETE' }),
  syncRepo: (fullName: string) => post<{ issues: number; prs: number }>(`/api/repos/${fullName}/sync`),
  setAutomation: (
    fullName: string,
    fields: { autoTriage?: boolean; digest?: boolean; staleSweep?: boolean; prGate?: boolean },
  ) => post<{ repo: RepoRecord }>(`/api/repos/${fullName}/automation`, fields),
  webhookInfo: (fullName: string) => post<WebhookInfo>(`/api/repos/${fullName}/webhook`),
  digestNow: (fullName: string) => post<{ ok: true }>(`/api/repos/${fullName}/digest-now`),
  staleNow: (fullName: string) => post<{ ok: true }>(`/api/repos/${fullName}/stale-now`),

  // issues
  listIssues: (fullName: string, state?: 'open' | 'closed') =>
    request<{ issues: IssueRecord[] }>(`/api/repos/${fullName}/issues${state ? `?state=${state}` : ''}`),
  getIssue: (fullName: string, number: number) =>
    request<{ issue: IssueRecord; triage: TriageResult | null }>(`/api/repos/${fullName}/issues/${number}`),
  listPrs: (fullName: string) => request<{ prs: PrRecord[] }>(`/api/repos/${fullName}/prs`),
  getPr: (fullName: string, number: number) =>
    request<{ pr: PrRecord; review: PrReviewResult | null }>(`/api/repos/${fullName}/prs/${number}`),
  analyzePr: (fullName: string, number: number) =>
    post<{ queued: true }>(`/api/repos/${fullName}/prs/${number}/analyze`),
  mergePr: (fullName: string, number: number, method: 'merge' | 'squash' | 'rebase') =>
    post<{ ok: true }>(`/api/repos/${fullName}/prs/${number}/merge`, { method }),
  closePr: (fullName: string, number: number) => post<{ ok: true }>(`/api/repos/${fullName}/prs/${number}/close`),
  applyPrReview: (id: string) => post<{ ok: true }>(`/api/pr-reviews/${id}/apply`),
  dismissPrReview: (id: string) => post<{ ok: true }>(`/api/pr-reviews/${id}/dismiss`),
  triageIssue: (fullName: string, number: number) =>
    post<{ queued: true }>(`/api/repos/${fullName}/issues/${number}/triage`),
  fixIssue: (fullName: string, number: number) =>
    post<{ run: RunRecord }>(`/api/repos/${fullName}/issues/${number}/fix`),
  applyTriage: (id: string, comment: boolean) => post<{ ok: true }>(`/api/triage/${id}/apply`, { comment }),
  dismissTriage: (id: string) => post<{ ok: true }>(`/api/triage/${id}/dismiss`),

  // proposals
  listProposals: () => request<{ proposals: ProposalRecord[] }>('/api/proposals'),
  createProposal: (repo: string, title: string, body: string) =>
    post<{ proposal: ProposalRecord }>('/api/proposals', { repo, title, body }),
  analyzeProposal: (id: string) => post<{ queued: true }>(`/api/proposals/${id}/analyze`),
  approveProposal: (id: string) => post<{ proposal: ProposalRecord }>(`/api/proposals/${id}/approve`),
  finishProposal: (id: string) => post<{ proposal: ProposalRecord }>(`/api/proposals/${id}/finish`),
  rejectProposal: (id: string) => post<{ ok: true }>(`/api/proposals/${id}/reject`),

  // reports + skills
  listReports: () => request<{ reports: ReportRecord[] }>('/api/reports'),
  listSkills: () => request<{ skills: SkillFile[] }>('/api/skills'),
  saveSkill: (name: string, content: string) =>
    request<{ skill: SkillFile }>(`/api/skills/${name}`, { method: 'PUT', body: JSON.stringify({ content }) }),
  deleteSkill: (name: string) => request<{ ok: true }>(`/api/skills/${name}`, { method: 'DELETE' }),

  // runs
  listRuns: () => request<{ runs: RunRecord[] }>('/api/runs'),
  createRun: (title?: string) => post<{ run: RunRecord }>('/api/runs', { title }),
  getRun: (id: string) => request<{ run: RunRecord; pendingAsks: AskRequest[] }>(`/api/runs/${id}`),
  history: (id: string, before: number | null, limit = 300) =>
    request<HistorySegment>(`/api/runs/${id}/history?limit=${limit}${before === null ? '' : `&before=${before}`}`),
  runDiff: (id: string) => request<{ diff: string; branch: string | null }>(`/api/runs/${id}/diff`),
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

type Listener = (msg: SpaServerMessage) => void;
const listeners = new Set<Listener>();
let ws: WebSocket | null = null;
let backoff = 500;

export function onServerMessage(fn: Listener): () => void {
  listeners.add(fn);
  void connectWs();
  return () => listeners.delete(fn);
}

async function connectWs(): Promise<void> {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const t = await ensureToken();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(t)}`);
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
  };
  ws.onclose = () => {
    ws = null;
    if (listeners.size > 0) {
      setTimeout(() => void connectWs(), backoff);
      backoff = Math.min(backoff * 2, 10_000);
    }
  };
}
