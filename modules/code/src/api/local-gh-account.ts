import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AuthMode } from '@moxxy/companion-contracts';

const execFileP = promisify(execFile);

export interface LocalGhAccount {
  readonly login: string;
  readonly token: string;
}

/**
 * Read the operator's active identity for `host` from their gh keyring. Used at
 * daemon boot to attach that identity to the oldest enabled admin; it is never a
 * runtime credential fallback and the token is never logged or written outside
 * the account store.
 */
export async function readActiveLocalGhAccount(
  host = 'github.com',
  authMode: AuthMode = 'password',
): Promise<LocalGhAccount | null> {
  // Importing the host operator's credential is a convenience of the trusted,
  // loopback-only npx appliance. In password mode the first administrator may
  // be a remote person and must never inherit whoever happens to own the host's
  // gh keyring. Defaulting to password makes future callers fail closed.
  if (authMode !== 'local') return null;
  if (process.env.COMPANION_IMPORT_LOCAL_GH === 'false') return null;
  try {
    const { stdout: raw } = await execFileP(
      'gh',
      ['auth', 'status', '--active', '--hostname', host, '--json', 'hosts'],
      { encoding: 'utf8', timeout: 5_000 },
    );
    const parsed = JSON.parse(raw) as {
      hosts?: Record<string, Array<{ active?: unknown; login?: unknown; state?: unknown }>>;
    };
    // `gh auth status` verifies GitHub over the network. The local identity is
    // still valid input when that probe reports `state: error`; `GitHubAccounts`
    // performs the authoritative token check before persisting anything.
    const account = parsed.hosts?.[host]?.find(
      (candidate) => candidate.active === true && typeof candidate.login === 'string',
    );
    const login = typeof account?.login === 'string' ? account.login.trim() : '';
    if (!login) return null;
    const { stdout } = await execFileP('gh', ['auth', 'token', '--hostname', host], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    const token = stdout.trim();
    return token ? { login, token } : null;
  } catch {
    return null;
  }
}
