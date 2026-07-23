import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdminSetup } from './setup.js';

const PENDING_FILE = 'pending-gh-import.json';

interface PendingGhImport {
  readonly login: string;
}

/** Active github.com identity from gh's local auth metadata. Never reads the token. */
export function detectGhLogin(): string | null {
  try {
    const raw = execFileSync(
      'gh',
      ['auth', 'status', '--active', '--hostname', 'github.com', '--json', 'hosts'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
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

/** Persist only consent + expected identity; the GitHub token stays in gh's keyring. */
export function scheduleGhImport(home: string, login: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, PENDING_FILE);
  writeFileSync(file, `${JSON.stringify({ login } satisfies PendingGhImport, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function pendingGhLogin(home: string): string | null {
  const file = join(home, PENDING_FILE);
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<PendingGhImport>;
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
export async function importPendingGhAccount(home: string, baseUrl: string, admin: AdminSetup): Promise<string | null> {
  const expected = pendingGhLogin(home);
  if (!expected) return null;
  const active = detectGhLogin();
  if (!active) throw new Error('GitHub import is pending, but gh is no longer authenticated for github.com.');
  if (active !== expected) {
    throw new Error(`GitHub import expects gh account ${expected}, but ${active} is active. Switch accounts or remove ${join(home, PENDING_FILE)}.`);
  }

  const token = readGhToken();
  const login = await requestJson<{ token: string }>(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: admin.username, password: admin.password }),
  });
  const authorization = `Bearer ${login.token}`;
  try {
    const common = { token, purposes: ['fetch', 'runs', 'pipelines', 'webhooks'], workspaceIds: [] };
    let response = await fetch(`${baseUrl}/api/github/accounts`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ ...common, scope: 'all' }),
    });
    if (response.status === 400) {
      response = await fetch(`${baseUrl}/api/github/accounts`, {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ ...common, scope: 'shared', shared: false }),
      });
    }
    if (!response.ok) throw new Error(await responseError(response, 'Companion rejected the GitHub account.'));
    rmSync(join(home, PENDING_FILE), { force: true });
    return active;
  } finally {
    await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST', headers: { authorization } }).catch(() => undefined);
  }
}

function readGhToken(): string {
  try {
    const token = execFileSync('gh', ['auth', 'token', '--hostname', 'github.com'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!token) throw new Error('empty token');
    return token;
  } catch {
    throw new Error('Could not read the active github.com token from gh. Run `gh auth login` and retry.');
  }
}

async function requestJson<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(await responseError(response, 'Companion request failed.'));
  return (await response.json()) as T;
}

async function responseError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === 'string' ? body.error : fallback;
  } catch {
    return fallback;
  }
}
