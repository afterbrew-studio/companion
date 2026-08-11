const ts = (): string => new Date().toISOString();

type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: -1, info: 0, warn: 1, error: 2, silent: 3 };

function configuredLevel(): LogLevel {
  const value = process.env.COMPANION_LOG_LEVEL?.trim().toLowerCase();
  return value === 'debug' || value === 'warn' || value === 'error' || value === 'silent' ? value : 'info';
}

function enabled(level: Exclude<LogLevel, 'silent'>): boolean {
  return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[configuredLevel()];
}

/** Read per call, like the level, so a test or a live reconfigure takes effect. */
function jsonFormat(): boolean {
  return process.env.COMPANION_LOG_FORMAT?.trim().toLowerCase() === 'json';
}

/** One machine-readable object per line; the reserved keys always win over fields. */
function jsonLine(
  level: Exclude<LogLevel, 'silent'>,
  scope: string,
  msg: string,
  fields?: Record<string, unknown>,
): string {
  const record = { ...fields, ts: ts(), level, scope, msg };
  try {
    return JSON.stringify(record);
  } catch {
    // A non-serializable field (circular, BigInt) must not cost the line itself.
    return JSON.stringify({ ts: record.ts, level, scope, msg });
  }
}

/** The `err` argument as structured fields: stack for errors, spread for objects. */
function errorFields(err: unknown): Record<string, unknown> | undefined {
  if (err === undefined) return undefined;
  if (err instanceof Error) return { err: err.stack ?? String(err) };
  if (typeof err === 'object' && err !== null && !Array.isArray(err)) return err as Record<string, unknown>;
  return { err: String(err) };
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

/**
 * A console logger tagged with `name` (e.g. `api`, a module id, `runner`).
 * COMPANION_LOG_FORMAT=json swaps the human-readable lines for one JSON object
 * per line (ts, level, scope, msg, plus the call site's structured fields),
 * which is what a log shipper wants to ingest.
 */
export function createLogger(name: string): Logger {
  return {
    debug(msg, meta) {
      if (!enabled('debug')) return;
      if (jsonFormat()) return void console.log(jsonLine('debug', name, msg, meta));
      console.log(`${ts()} [${name}] DEBUG ${msg}`, meta ?? '');
    },
    info(msg, meta) {
      if (!enabled('info')) return;
      if (jsonFormat()) return void console.log(jsonLine('info', name, msg, meta));
      console.log(`${ts()} [${name}] ${msg}`, meta ?? '');
    },
    warn(msg, meta) {
      if (!enabled('warn')) return;
      if (jsonFormat()) return void console.warn(jsonLine('warn', name, msg, meta));
      console.warn(`${ts()} [${name}] WARN ${msg}`, meta ?? '');
    },
    error(msg, err) {
      if (!enabled('error')) return;
      if (jsonFormat()) return void console.error(jsonLine('error', name, msg, errorFields(err)));
      console.error(`${ts()} [${name}] ERROR ${msg}`, err ?? '');
    },
  };
}

/** Default process logger. Apps/modules may create their own tagged logger. */
export const log: Logger = createLogger('companion');
