import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseEnvFile,
  readRegularTextFile,
  writePrivateTextFile,
  type AuthMode,
} from '@moxxy/companion-services';

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,39}$/i;
const DEFAULT_EMAIL = 'admin@companion.local';
const PENDING_SETUP_FILE = 'pending-admin-setup.json';

/**
 * Where an admin password came from, which is what decides whether the setup
 * box may print it. A generated one has to be shown once or it is lost; the
 * operator's chosen one is never echoed back.
 */
export type PasswordSource = 'generated' | 'chosen';

export interface AdminSetup {
  readonly username: string;
  readonly email: string;
  readonly password: string;
  readonly passwordSource: PasswordSource;
}

/**
 * What an install nobody is watching gets: a predictable identity and an
 * unpredictable credential. A `-y` run must never publish a well-known login.
 */
export function createDefaultAdmin(): AdminSetup {
  return {
    username: 'admin',
    email: DEFAULT_EMAIL,
    password: randomBytes(18).toString('base64url'),
    passwordSource: 'generated',
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
  if (readStoredAuthMode(home) !== null) return true;
  const file = join(home, '.env');
  try {
    const raw = readRegularTextFile(file, { maxBytes: 1024 * 1024 });
    return /^\s*COMPANION_ADMIN_USER\s*=.+$/m.test(raw) && /^\s*COMPANION_ADMIN_PASSWORD\s*=.+$/m.test(raw);
  } catch {
    return false;
  }
}

/** An explicit field doubles as the npx install marker; old/networked homes
 * without it remain on the daemon's safe password default. */
export function readStoredAuthMode(home: string): AuthMode | null {
  const file = join(home, 'companiond.json');
  try {
    const value = JSON.parse(readRegularTextFile(file, { maxBytes: 1024 * 1024 })) as { authMode?: unknown };
    return value.authMode === 'local' || value.authMode === 'password' || value.authMode === 'sso'
      ? value.authMode
      : null;
  } catch {
    return null;
  }
}

/** Merge instead of replacing: host, port and future daemon settings belong to
 * the same operator-owned file. */
export function writeStoredAuthMode(home: string, authMode: AuthMode): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, 'companiond.json');
  let stored: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readRegularTextFile(file, { maxBytes: 1024 * 1024 })) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed as Record<string, unknown>;
  } catch {
    // A missing or malformed file is replaced with the one setting the CLI
    // owns. The daemon would otherwise ignore it and silently choose another mode.
  }
  writePrivateTextFile(file, `${JSON.stringify({ ...stored, authMode }, null, 2)}\n`);
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
  // Read back rather than decided here, so its origin is unknown and the
  // conservative reading is the one that never prints it.
  return { username, email, password, passwordSource: 'chosen' };
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
  writePrivateTextFile(join(home, PENDING_PROFILE_FILE), `${JSON.stringify({ modules }, null, 2)}\n`);
}

/** Read and clear: installing is a first-run act, not something to repeat. */
export function takePendingProfile(home: string): readonly string[] {
  const file = join(home, PENDING_PROFILE_FILE);
  try {
    const parsed = JSON.parse(readRegularTextFile(file, { maxBytes: 1024 * 1024, mode: 0o600 })) as {
      modules?: unknown;
    };
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
  writePrivateTextFile(
    file,
    `${JSON.stringify({ username: setup.username, email: setup.email, password: setup.password }, null, 2)}\n`,
  );
  return file;
}

export function readPendingAdminSetup(home: string): AdminSetup | null {
  const file = join(home, PENDING_SETUP_FILE);
  try {
    const value = JSON.parse(readRegularTextFile(file, { maxBytes: 1024 * 1024, mode: 0o600 })) as Partial<AdminSetup>;
    if (typeof value.username !== 'string' || typeof value.email !== 'string' || typeof value.password !== 'string') {
      return null;
    }
    return { username: value.username, email: value.email, password: value.password, passwordSource: 'chosen' };
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
    ['Password', setup.passwordSource === 'chosen' ? '•••••••• (chosen)' : setup.password],
  ] as const;
  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  const lines = ['Companion local setup', ...rows.map(([label, value]) => `${label.padEnd(labelWidth)}  ${value}`)];
  const width = Math.max(...lines.map((line) => line.length));
  const row = (line: string): string => `│ ${line.padEnd(width)} │`;
  return [`┌${'─'.repeat(width + 2)}┐`, ...lines.map(row), `└${'─'.repeat(width + 2)}┘`].join('\n');
}
