import { execFileSync } from 'node:child_process';

export interface LocalGhAccount {
  readonly login: string;
  readonly token: string;
}

/**
 * Read the active github.com identity from the operator's gh keyring. This is
 * used only during first-user env bootstrap; it is never a runtime credential
 * fallback and the token is never logged or written outside the account store.
 */
export function readActiveLocalGhAccount(): LocalGhAccount | null {
  if (process.env.COMPANION_IMPORT_LOCAL_GH === 'false') return null;
  try {
    const raw = execFileSync(
      'gh',
      ['auth', 'status', '--active', '--hostname', 'github.com', '--json', 'hosts'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 },
    );
    const parsed = JSON.parse(raw) as {
      hosts?: Record<string, Array<{ active?: unknown; login?: unknown; state?: unknown }>>;
    };
    const account = parsed.hosts?.['github.com']?.find(
      (candidate) => candidate.active === true && candidate.state === 'success' && typeof candidate.login === 'string',
    );
    const login = typeof account?.login === 'string' ? account.login.trim() : '';
    if (!login) return null;
    const token = execFileSync('gh', ['auth', 'token', '--hostname', 'github.com'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    }).trim();
    return token ? { login, token } : null;
  } catch {
    return null;
  }
}
