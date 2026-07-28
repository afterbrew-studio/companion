import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnvFile } from '@moxxy/companion-services';

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,39}$/i;
const DEFAULT_EMAIL = 'admin@companion.local';
const PENDING_SETUP_FILE = 'pending-admin-setup.json';

export interface AdminSetup {
  readonly username: string;
  readonly email: string;
  readonly password: string;
  readonly generatedPassword: boolean;
}

/** Secure local defaults: predictable identity, one-time random credential. */
export function createDefaultAdmin(): AdminSetup {
  return {
    username: 'admin',
    email: DEFAULT_EMAIL,
    password: randomBytes(18).toString('base64url'),
    generatedPassword: true,
  };
}

export function validateUsername(value: string): true | string {
  return USERNAME_RE.test(value.trim()) || 'Use 2–40 letters, digits, dots, dashes, or underscores.';
}

export function validateEmail(value: string): true | string {
  const email = value.trim();
  return (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 200) || 'Enter a valid email address.';
}

export function validatePassword(value: string): true | string {
  if (value.length < 8) return 'Use at least 8 characters.';
  if (value.length > 500) return 'Use at most 500 characters.';
  if (/[\r\n]/.test(value)) return 'Password cannot contain a line break.';
  return true;
}

/** Existing DB means browser onboarding or env seeding has already run. */
export function setupExists(home: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.COMPANION_ADMIN_USER?.trim() && env.COMPANION_ADMIN_PASSWORD) return true;
  if (existsSync(join(home, 'companion.db'))) return true;
  if (existsSync(join(home, PENDING_SETUP_FILE))) return true;
  const file = join(home, '.env');
  if (!existsSync(file)) return false;
  const raw = readFileSync(file, 'utf8');
  return /^\s*COMPANION_ADMIN_USER\s*=.+$/m.test(raw) && /^\s*COMPANION_ADMIN_PASSWORD\s*=.+$/m.test(raw);
}

/** Credentials are needed once to authenticate the bootstrap API request. */
export function readAdminSetup(home: string, env: NodeJS.ProcessEnv = process.env): AdminSetup | null {
  const pending = readPendingAdminSetup(home);
  const file = join(home, '.env');
  const stored = parseEnvFile(file);
  const username = env.COMPANION_ADMIN_USER?.trim() || pending?.username || stored.COMPANION_ADMIN_USER?.trim();
  const email =
    env.COMPANION_ADMIN_EMAIL?.trim() || pending?.email || stored.COMPANION_ADMIN_EMAIL?.trim() || DEFAULT_EMAIL;
  const password = env.COMPANION_ADMIN_PASSWORD || pending?.password || stored.COMPANION_ADMIN_PASSWORD;
  if (!username || !password) return null;
  return { username, email, password, generatedPassword: false };
}

const PENDING_PROFILE_FILE = 'pending-profile.json';

/**
 * The chosen module set, held between `init` and the first `start`.
 *
 * Separate from the credentials file, which is deleted the moment the daemon
 * consumes it: the modules are installed after the daemon is up, which is later.
 */
export function writePendingProfile(home: string, modules: readonly string[]): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, PENDING_PROFILE_FILE), `${JSON.stringify({ modules }, null, 2)}\n`, { mode: 0o600 });
}

/** Read and clear: installing is a first-run act, not something to repeat. */
export function takePendingProfile(home: string): readonly string[] {
  const file = join(home, PENDING_PROFILE_FILE);
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { modules?: unknown };
    rmSync(file, { force: true });
    return Array.isArray(parsed.modules) ? parsed.modules.filter((m): m is string => typeof m === 'string') : [];
  } catch {
    rmSync(file, { force: true });
    return [];
  }
}

/** Store credentials only until the first successful daemon boot. */
export function writePendingAdminSetup(home: string, setup: AdminSetup): string {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, PENDING_SETUP_FILE);
  writeFileSync(
    file,
    `${JSON.stringify({ username: setup.username, email: setup.email, password: setup.password }, null, 2)}\n`,
    { mode: 0o600 },
  );
  chmodSync(file, 0o600);
  return file;
}

export function readPendingAdminSetup(home: string): AdminSetup | null {
  const file = join(home, PENDING_SETUP_FILE);
  if (!existsSync(file)) return null;
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<AdminSetup>;
    if (typeof value.username !== 'string' || typeof value.email !== 'string' || typeof value.password !== 'string') {
      return null;
    }
    return { username: value.username, email: value.email, password: value.password, generatedPassword: false };
  } catch {
    return null;
  }
}

/** Pass the pending seed in memory to the daemon config loader. */
export function applyPendingAdminSetup(home: string): AdminSetup | null {
  const setup = readPendingAdminSetup(home);
  if (!setup) return null;
  process.env.COMPANION_ADMIN_USER = setup.username;
  process.env.COMPANION_ADMIN_EMAIL = setup.email;
  process.env.COMPANION_ADMIN_PASSWORD = setup.password;
  return setup;
}

export function consumePendingAdminSetup(home: string): void {
  rmSync(join(home, PENDING_SETUP_FILE), { force: true });
}

export function renderSetupBox(setup: AdminSetup, home: string, url: string): string {
  const rows = [
    ['URL', url],
    ['Data', home],
    ['Username', setup.username],
    ['Email', setup.email],
    ['Password', setup.generatedPassword ? setup.password : '•••••••• (chosen)'],
  ] as const;
  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  const lines = ['Companion local setup', ...rows.map(([label, value]) => `${label.padEnd(labelWidth)}  ${value}`)];
  const width = Math.max(...lines.map((line) => line.length));
  const row = (line: string): string => `│ ${line.padEnd(width)} │`;
  return [`┌${'─'.repeat(width + 2)}┐`, ...lines.map(row), `└${'─'.repeat(width + 2)}┘`].join('\n');
}
