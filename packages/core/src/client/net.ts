import type { SpaServerMessage } from '@companion/contracts';

/**
 * The single REST + WebSocket core for the SPA — extracted verbatim from the
 * legacy `lib/api.ts`. Auth is a login session token (localStorage); every 401
 * clears it and notifies the auth layer so the app falls back to the login
 * screen. EXACTLY ONE WebSocket app-wide: module api slices import `request`/
 * `post`/`onServerMessage` from here and never open their own socket.
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

/**
 * Turn a failed response body into something a user can act on.
 *
 * A body-schema rejection arrives as `{ error: 'invalid request', issues: [...] }`
 * where the issues carry the message the schema author wrote ("letters, digits,
 * dots, dashes (2-40 chars)"). Showing only `error` threw that away and put
 * "invalid request" under every form field in the app, which tells the user
 * nothing about what to change.
 */
function errorMessage(body: { error?: string; issues?: unknown }, res: Response): string {
  const issues = Array.isArray(body.issues) ? (body.issues as Array<{ path?: unknown[]; message?: string }>) : [];
  const detail = issues
    .map((i) => {
      const field = Array.isArray(i.path) ? i.path.filter((p) => typeof p === 'string').join('.') : '';
      return field && i.message ? `${field}: ${i.message}` : (i.message ?? '');
    })
    .filter(Boolean)
    .join('; ');
  if (detail) return detail;
  return body.error ?? `${res.status} ${res.statusText}`;
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
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

export function emitAuthChanged(): void {
  for (const fn of [...authListeners]) fn();
}

/** Re-resolve the session (e.g. after editing your own display name). */
export function refreshAuth(): void {
  emitAuthChanged();
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
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
    const body = (await res.json().catch(() => ({}))) as { error?: string; issues?: unknown };
    throw new ApiError(errorMessage(body, res), res.status);
  }
  return (await res.json()) as T;
}

export const post = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
export const put = <T>(path: string, body: unknown): Promise<T> =>
  request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
export const patch = <T>(path: string, body: unknown): Promise<T> =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
export const del = <T>(path: string): Promise<T> => request<T>(path, { method: 'DELETE' });

/** Unauthenticated POST (login/setup flows). */
export async function publicPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const parsed = (await res.json().catch(() => ({}))) as { error?: string; issues?: unknown };
    throw new ApiError(errorMessage(parsed, res), res.status);
  }
  return (await res.json()) as T;
}

/** Server-side paging/search window for list endpoints. */
export interface PageQuery {
  q?: string;
  repo?: string;
  limit?: number;
  offset?: number;
}

export function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') sp.set(k, String(v));
  }
  const str = sp.toString();
  return str ? `?${str}` : '';
}

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

export function disconnectWs(): void {
  const socket = ws;
  ws = null;
  socket?.close();
  setWsState('offline');
}
