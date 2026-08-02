const ts = (): string => new Date().toISOString().slice(11, 23);

type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: -1, info: 0, warn: 1, error: 2, silent: 3 };

function configuredLevel(): LogLevel {
  const value = process.env.COMPANION_LOG_LEVEL?.trim().toLowerCase();
  return value === 'debug' || value === 'warn' || value === 'error' || value === 'silent' ? value : 'info';
}

function enabled(level: Exclude<LogLevel, 'silent'>): boolean {
  return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[configuredLevel()];
}

export interface Logger {
  /**
   * Detail worth having when something is being diagnosed and worth nothing
   * otherwise: expected lifecycle transitions, retries that succeeded. OFF
   * unless COMPANION_LOG_LEVEL=debug — the bar for a line the operator sees on
   * every boot is that it tells them something they must act on.
   */
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, err?: unknown): void;
}

/** A console logger tagged with `name` (e.g. `api`, a module id, `runner`). */
export function createLogger(name: string): Logger {
  return {
    debug(msg, meta) {
      if (!enabled('debug')) return;
      console.log(`${ts()} [${name}] DEBUG ${msg}`, meta ?? '');
    },
    info(msg, meta) {
      if (!enabled('info')) return;
      console.log(`${ts()} [${name}] ${msg}`, meta ?? '');
    },
    warn(msg, meta) {
      if (!enabled('warn')) return;
      console.warn(`${ts()} [${name}] WARN ${msg}`, meta ?? '');
    },
    error(msg, err) {
      if (!enabled('error')) return;
      console.error(`${ts()} [${name}] ERROR ${msg}`, err ?? '');
    },
  };
}

/** Default process logger. Apps/modules may create their own tagged logger. */
export const log: Logger = createLogger('companion');
