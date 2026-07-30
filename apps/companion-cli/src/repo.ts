/**
 * Offering the repository the CLI was started in.
 *
 * `npx @moxxy/companion` is almost always run from inside the thing the
 * operator wants Companion to work on, and that is a fact worth using: the
 * alternative is a fresh instance whose first screen is an empty repository
 * list and a picker, for a repository they were standing in when they started.
 *
 * Detected, not asked, in the same spirit as the harness question. A directory
 * with no GitHub origin produces no question at all rather than a prompt with
 * nothing useful to answer, and a repository Companion already tracks is not
 * offered twice.
 *
 * A declined repository is remembered, because "later" means every subsequent
 * start from that directory and a question re-asked on every start is a
 * question that stops being read.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DECLINED_FILE = 'declined-repos.json';

/** `owner/name` of this directory's GitHub origin, or null if it has none. */
export function detectRepo(cwd: string): string | null {
  try {
    const remote = execFileSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    return parseGitHubRemote(remote);
  } catch {
    return null;
  }
}

/**
 * `owner/name` from a git remote, for github.com and nothing else.
 *
 * The host is compared whole rather than searched for, because `github.com` is
 * a substring of hosts nobody's repositories live on, and Companion's GitHub
 * client talks to github.com: reading an enterprise remote as one of those
 * would offer to add a repository that cannot then be fetched.
 */
export function parseGitHubRemote(remote: string): string | null {
  const url = remote.trim();
  // Two spellings: `scheme://[user@]host[:port]/path` and scp-like `[user@]host:path`.
  const uri = url.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i);
  const scp = url.includes('://') ? null : url.match(/^(?:[^@/]+@)?([^/:]+):(.+)$/);
  const host = uri?.[1] ?? scp?.[1];
  const path = uri?.[2] ?? scp?.[2];
  if (!host || !path || host.toLowerCase() !== 'github.com') return null;
  const parts = path.replace(/\.git$/i, '').replace(/\/+$/, '').split('/');
  const [owner, name] = parts;
  if (parts.length !== 2 || !owner || !name) return null;
  // The same shape the add-repo route accepts, so a name it would reject is
  // never offered.
  return /^[\w.-]+$/.test(owner) && /^[\w.-]+$/.test(name) ? `${owner}/${name}` : null;
}

export function declinedRepos(home: string): readonly string[] {
  const file = join(home, DECLINED_FILE);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { repos?: unknown };
    return Array.isArray(parsed.repos) ? parsed.repos.filter((r): r is string => typeof r === 'string') : [];
  } catch {
    return [];
  }
}

export function declineRepo(home: string, fullName: string): void {
  const repos = [...new Set([...declinedRepos(home), fullName])];
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(join(home, DECLINED_FILE), `${JSON.stringify({ repos }, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // Not remembering costs one repeated question, which is not worth failing a
    // start over.
  }
}

/**
 * What this instance already tracks. Null is an instance without the code
 * module, or a daemon that could not answer: neither is a question to ask.
 */
export async function trackedRepos(baseUrl: string, token: string): Promise<readonly string[] | null> {
  try {
    const res = await fetch(`${baseUrl}/api/repos`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const body = (await res.json()) as { repos?: Array<{ fullName?: unknown }> };
    return (body.repos ?? [])
      .map((repo) => repo.fullName)
      .filter((name): name is string => typeof name === 'string');
  } catch {
    return null;
  }
}

/**
 * Where a repository added from here lands: the first workspace this instance
 * has, which on a fresh install is the default one and on any other is the
 * oldest. Choosing between several is a question the web UI is better at.
 */
export async function firstWorkspaceId(baseUrl: string, token: string): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl}/api/workspaces`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const body = (await res.json()) as { workspaces?: Array<{ id?: unknown }> };
    const id = body.workspaces?.[0]?.id;
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

export async function addRepo(
  baseUrl: string,
  token: string,
  fullName: string,
  workspaceId: string,
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/repos`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ fullName, workspaceId }),
  });
  if (res.ok) return;
  // The route's own refusals name the account that could not reach the
  // repository, which is the whole answer; anything else falls back to status.
  const text = await res.text();
  let message = `${res.status}`;
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === 'string') message = parsed.error;
  } catch {
    if (text) message = text.slice(0, 200);
  }
  throw new Error(message);
}
