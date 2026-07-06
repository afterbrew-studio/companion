import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Companion's own data root (NOT moxxy's). Everything Companion persists lives
 * under here, including the isolated moxxy home that keeps agent sessions
 * invisible to the user's daily `~/.moxxy`.
 */
export const companionHome = (): string =>
  process.env.COMPANION_HOME ?? join(homedir(), '.companion');

export const paths = {
  root: (): string => companionHome(),
  /** Isolated MOXXY_HOME for every runner Companion spawns. */
  moxxyHome: (): string => join(companionHome(), 'moxxy-home'),
  sockets: (): string => join(companionHome(), 'moxxy-home', 'sockets'),
  sessions: (): string => join(companionHome(), 'moxxy-home', 'sessions'),
  repos: (): string => join(companionHome(), 'repos'),
  worktrees: (): string => join(companionHome(), 'worktrees'),
  scratch: (): string => join(companionHome(), 'scratch'),
  /** Per-run explicit moxxy config files (passed via `moxxy --config`). */
  runConfigs: (): string => join(companionHome(), 'run-configs'),
  db: (): string => join(companionHome(), 'companion.db'),
  daemonConfig: (): string => join(companionHome(), 'companiond.json'),
};

export interface DaemonConfig {
  /** Port the companiond HTTP+WS server binds on 127.0.0.1. */
  port: number;
  /** Bearer token the SPA uses for /api and the SPA WebSocket. */
  spaToken: string;
  /** Max concurrently live gateway processes. */
  maxLiveRuns: number;
  /** Explicit path to the moxxy CLI entry (overrides PATH lookup). */
  moxxyCliPath?: string;
}

const DEFAULTS: Omit<DaemonConfig, 'spaToken'> = {
  port: 8901,
  maxLiveRuns: 3,
};

/** Load (or create on first boot) the daemon config. Also creates the dir layout. */
export function loadDaemonConfig(): DaemonConfig {
  for (const dir of [
    paths.root(),
    paths.moxxyHome(),
    paths.sockets(),
    paths.repos(),
    paths.worktrees(),
    paths.scratch(),
    paths.runConfigs(),
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  const file = paths.daemonConfig();
  if (existsSync(file)) {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<DaemonConfig>;
    return {
      ...DEFAULTS,
      spaToken: typeof raw.spaToken === 'string' && raw.spaToken ? raw.spaToken : mintToken(),
      ...raw,
    } as DaemonConfig;
  }
  const config: DaemonConfig = { ...DEFAULTS, spaToken: mintToken() };
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  return config;
}

function mintToken(): string {
  return randomBytes(32).toString('hex');
}
