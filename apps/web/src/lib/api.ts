import type {
  AskRequest,
  HistorySegment,
  MoxxyStatus,
  RunRecord,
  SpaServerMessage,
} from '@companion/contract';

/**
 * REST + WebSocket client for companiond. One WS connection app-wide; per-run
 * listeners subscribe to the multiplexed stream by runId.
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

export const api = {
  status: () => request<MoxxyStatus>('/api/status'),
  importProviders: () =>
    request<{ imported: string[]; missing: string[] }>('/api/moxxy/import-providers', {
      method: 'POST',
      body: '{}',
    }),
  listRuns: () => request<{ runs: RunRecord[] }>('/api/runs'),
  createRun: (title?: string) =>
    request<{ run: RunRecord }>('/api/runs', { method: 'POST', body: JSON.stringify({ title }) }),
  getRun: (id: string) => request<{ run: RunRecord; pendingAsks: AskRequest[] }>(`/api/runs/${id}`),
  history: (id: string, before: number | null, limit = 300) =>
    request<HistorySegment>(
      `/api/runs/${id}/history?limit=${limit}${before === null ? '' : `&before=${before}`}`,
    ),
  prompt: (id: string, prompt: string) =>
    request<{ turnId: string }>(`/api/runs/${id}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ prompt }),
    }),
  abort: (id: string, turnId?: string) =>
    request<{ ok: true }>(`/api/runs/${id}/abort`, {
      method: 'POST',
      body: JSON.stringify({ turnId }),
    }),
  respondAsk: (id: string, requestId: string, response: Record<string, unknown>) =>
    request<{ ok: true }>(`/api/runs/${id}/ask`, {
      method: 'POST',
      body: JSON.stringify({ requestId, response }),
    }),
  resumeRun: (id: string) => request<{ run: RunRecord }>(`/api/runs/${id}/resume`, { method: 'POST', body: '{}' }),
  stopRun: (id: string) => request<{ ok: true }>(`/api/runs/${id}/stop`, { method: 'POST', body: '{}' }),
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
