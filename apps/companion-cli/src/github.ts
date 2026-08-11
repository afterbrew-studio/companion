import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readRegularTextFile, writePrivateTextFile } from '@moxxy/companion-services';
const PENDING_FILE = 'pending-gh-import.json';

interface PendingGhImport {
  readonly login: string;
}

export interface CompanionCredentials {
  readonly username: string;
  readonly password: string;
}

export type CompanionAuth = CompanionCredentials | { readonly bearerToken: string };

/** Active github.com identity from gh's local auth metadata. Never reads the token. */
export function detectGhLogin(): string | null {
  try {
    const raw = execFileSync(
      'gh',
      ['auth', 'status', '--active', '--hostname', 'github.com', '--json', 'hosts'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 },
    );
    return parseGhLogin(raw);
  } catch {
    return null;
  }
}

export function parseGhLogin(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as {
      hosts?: Record<string, Array<{ active?: unknown; login?: unknown; state?: unknown }>>;
    };
    const account = parsed.hosts?.['github.com']?.find(
      (candidate) => candidate.active === true && candidate.state === 'success' && typeof candidate.login === 'string',
    );
    return account && typeof account.login === 'string' && account.login.trim() ? account.login.trim() : null;
  } catch {
    return null;
  }
}

/** Persist only the expected identity; the GitHub token stays in gh's keyring. */
export function scheduleGhImport(home: string, login: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, PENDING_FILE);
  writePrivateTextFile(file, `${JSON.stringify({ login } satisfies PendingGhImport, null, 2)}\n`);
}

export function pendingGhLogin(home: string): string | null {
  const file = join(home, PENDING_FILE);
  try {
    const value = JSON.parse(readRegularTextFile(file, { maxBytes: 4_096, mode: 0o600 })) as Partial<PendingGhImport>;
    return typeof value.login === 'string' && value.login.trim() ? value.login.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Complete the one-time import through Companion's authenticated HTTP API.
 * This deliberately does not write directly to SQLite and never stores or
 * prints the token. The modern personal-only payload is tried first; the
 * legacy personal payload keeps this CLI safe if it is run against Companion
 * just before the personal-account migration lands.
 */
export async function importPendingGhAccount(
  home: string,
  baseUrl: string,
  auth: CompanionAuth,
): Promise<string | null> {
  const expected = pendingGhLogin(home);
  if (!expected) return null;
  const active = await connectGhAccount(baseUrl, auth, expected);
  rmSync(join(home, PENDING_FILE), { force: true });
  return active;
}

/** Connect the active gh identity to the authenticated Companion user. */
export async function connectGhAccount(
  baseUrl: string,
  auth: CompanionAuth,
  expectedLogin?: string,
): Promise<string> {
  const active = detectGhLogin();
  if (!active) throw new Error('gh is not authenticated for github.com. Run `gh auth login` and retry.');
  if (expectedLogin && active !== expectedLogin) {
    throw new Error(`GitHub import expects gh account ${expectedLogin}, but ${active} is active. Switch accounts and retry.`);
  }

  const token = readGhToken();
  const borrowedSession = 'bearerToken' in auth;
  let sessionHeaders: Record<string, string>;
  if (borrowedSession) {
    sessionHeaders = { authorization: `Bearer ${auth.bearerToken}` };
  } else {
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-companion-csrf': '1' },
      body: JSON.stringify({ username: auth.username, password: auth.password }),
    });
    if (!login.ok) throw new Error(await responseError(login, 'Companion sign-in failed.'));
    const setCookie = login.headers.get('set-cookie');
    if (!setCookie) throw new Error('Companion sign-in returned no session cookie.');
    sessionHeaders = { cookie: setCookie.split(';', 1)[0]!, 'x-companion-csrf': '1' };
  }
  try {
    const common = { token, purposes: ['fetch', 'runs', 'pipelines', 'webhooks'], workspaceIds: [] };
    let response = await fetch(`${baseUrl}/api/github/accounts`, {
      method: 'POST',
      headers: { ...sessionHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ ...common, scope: 'all' }),
    });
    if (response.status === 400) {
      response = await fetch(`${baseUrl}/api/github/accounts`, {
        method: 'POST',
        headers: { ...sessionHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ ...common, scope: 'shared', shared: false }),
      });
    }
    if (!response.ok) throw new Error(await responseError(response, 'Companion rejected the GitHub account.'));
    return active;
  } finally {
    // Never revoke the daemon-owned CLI session merely because this command
    // borrowed it. A password login above is disposable and is cleaned up.
    if (!borrowedSession) {
      await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST', headers: sessionHeaders }).catch(() => undefined);
    }
  }
}

function readGhToken(): string {
  try {
    const token = execFileSync('gh', ['auth', 'token', '--hostname', 'github.com'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim();
    if (!token) throw new Error('empty token');
    return token;
  } catch {
    throw new Error('Could not read the active github.com token from gh. Run `gh auth login` and retry.');
  }
}

async function responseError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : fallback;
  } catch {
    return fallback;
  }
}
