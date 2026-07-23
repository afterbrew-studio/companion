import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnvFile } from '@companion/services';

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,39}$/i;
const DEFAULT_EMAIL = 'admin@companion.local';

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
  const file = join(home, '.env');
  if (!existsSync(file)) return false;
  const raw = readFileSync(file, 'utf8');
  return /^\s*COMPANION_ADMIN_USER\s*=.+$/m.test(raw) && /^\s*COMPANION_ADMIN_PASSWORD\s*=.+$/m.test(raw);
}

/** Credentials are needed once to authenticate the bootstrap API request. */
export function readAdminSetup(home: string, env: NodeJS.ProcessEnv = process.env): AdminSetup | null {
  const file = join(home, '.env');
  const stored = parseEnvFile(file);
  const username = env.COMPANION_ADMIN_USER?.trim() || stored.COMPANION_ADMIN_USER?.trim();
  const email = env.COMPANION_ADMIN_EMAIL?.trim() || stored.COMPANION_ADMIN_EMAIL?.trim() || DEFAULT_EMAIL;
  const password = env.COMPANION_ADMIN_PASSWORD || stored.COMPANION_ADMIN_PASSWORD;
  if (!username || !password) return null;
  return { username, email, password, generatedPassword: false };
}

/** Preserve unrelated settings while replacing any partial admin seed. */
export function writeAdminSetup(home: string, setup: AdminSetup): string {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = join(home, '.env');
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const retained = existing
    .split(/\r?\n/)
    .filter((line) => !/^\s*COMPANION_ADMIN_(USER|EMAIL|PASSWORD)\s*=/.test(line))
    .join('\n')
    .trimEnd();
  const admin = [
    `COMPANION_ADMIN_USER=${JSON.stringify(setup.username)}`,
    `COMPANION_ADMIN_EMAIL=${JSON.stringify(setup.email)}`,
    `COMPANION_ADMIN_PASSWORD=${JSON.stringify(setup.password)}`,
  ].join('\n');
  writeFileSync(file, `${retained ? `${retained}\n\n` : ''}${admin}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
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
