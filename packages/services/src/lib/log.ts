const ts = (): string => new Date().toISOString().slice(11, 23);

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, err?: unknown): void;
}

/** A console logger tagged with `name` (e.g. `api`, a module id, `runner`). */
export function createLogger(name: string): Logger {
  return {
    info(msg, meta) {
      console.log(`${ts()} [${name}] ${msg}`, meta ?? '');
    },
    warn(msg, meta) {
      console.warn(`${ts()} [${name}] WARN ${msg}`, meta ?? '');
    },
    error(msg, err) {
      console.error(`${ts()} [${name}] ERROR ${msg}`, err ?? '');
    },
  };
}

/** Default process logger. Apps/modules may create their own tagged logger. */
export const log: Logger = createLogger('companion');
