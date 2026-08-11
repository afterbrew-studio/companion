import { paths, readRegularTextFile } from '@moxxy/companion-services';

/**
 * The CLI's transport to a running daemon. Authentication is the bearer token
 * the daemon mints at boot into COMPANION_HOME (mode 0600). The CLI never asks
 * for a password and never holds one.
 */
export function readToken(): string {
  const file = paths.cliToken();
  let token: string;
  try {
    token = readRegularTextFile(file, { maxBytes: 4_096, mode: 0o600 }).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    throw new Error(
      `No CLI token at ${file}.\n` +
        `The daemon writes it at boot once an admin account exists. Start Companion, complete\n` +
        `first-run setup if you have not, then restart it once.`,
    );
  }
  if (!token) throw new Error(`${file} is empty. Delete it and restart Companion to mint a new token.`);
  return token;
}

export type ApiClient = <T>(method: string, path: string, body?: unknown) => Promise<T>;

export function apiClient(baseUrl: string, explicitToken?: string, timeoutMs?: number): ApiClient {
  const providedToken = explicitToken?.trim();
  const token = providedToken || readToken();
  return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new Error(`Companion request timed out after ${timeoutMs} ms.`);
      }
      throw new Error(`Companion is not reachable at ${baseUrl}. Start it, or pass --host/--port.`);
    }
    const text = await response.text();
    let parsed: unknown = {};
    if (text) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = text;
      }
    }
    if (response.ok) return parsed as T;
    const message =
      typeof parsed === 'object' && parsed !== null && typeof (parsed as { error?: unknown }).error === 'string'
        ? (parsed as { error: string }).error
        : `HTTP ${response.status}`;
    if (response.status === 401) {
      throw new Error(
        providedToken
          ? `${message}. COMPANION_TOKEN was rejected.`
          : `${message}. The token in ${paths.cliToken()} is stale. Delete it and restart Companion.`,
      );
    }
    throw new Error(message);
  };
}
