const ts = (): string => new Date().toISOString().slice(11, 23);

type LogLevel = 'info' | 'warn' | 'error' | 'silent';
const LEVEL_WEIGHT: Record<LogLevel, number> = { info: 0, warn: 1, error: 2, silent: 3 };

function configuredLevel(): LogLevel {
  const value = process.env.COMPANION_LOG_LEVEL?.trim().toLowerCase();
  return value === 'warn' || value === 'error' || value === 'silent' ? value : 'info';
}

function enabled(level: Exclude<LogLevel, 'silent'>): boolean {
  return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[configuredLevel()];
}

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, err?: unknown): void;
}

/** A console logger tagged with `name` (e.g. `api`, a module id, `runner`). */
export function createLogger(name: string): Logger {
  return {
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
