import { existsSync, readFileSync } from 'node:fs';
import { paths } from '@companion/services';

/**
 * The CLI's transport to a running daemon. Authentication is the bearer token
 * the daemon mints at boot into COMPANION_HOME (mode 0600). The CLI never asks
 * for a password and never holds one.
 */
export function readToken(): string {
  const file = paths.cliToken();
  if (!existsSync(file)) {
    throw new Error(
      `No CLI token at ${file}.\n` +
        `The daemon writes it at boot once an admin account exists. Start Companion, complete\n` +
        `first-run setup if you have not, then restart it once.`,
    );
  }
  const token = readFileSync(file, 'utf8').trim();
  if (!token) throw new Error(`${file} is empty. Delete it and restart Companion to mint a new token.`);
  return token;
}

export type ApiClient = <T>(method: string, path: string, body?: unknown) => Promise<T>;

export function apiClient(baseUrl: string): ApiClient {
  const token = readToken();
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error(`Companion is not reachable at ${baseUrl}. Start it, or pass --host/--port.`);
    }
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as unknown) : {};
    if (response.ok) return parsed as T;
    const message = (parsed as { error?: string }).error ?? `HTTP ${response.status}`;
    if (response.status === 401) {
      throw new Error(`${message}. The token in ${paths.cliToken()} is stale. Delete it and restart Companion.`);
    }
    throw new Error(message);
  };
}
