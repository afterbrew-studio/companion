const ts = (): string => new Date().toISOString().slice(11, 23);

/**
 * Where log lines go instead of stdout.
 *
 * The dashboard owns the screen while it is up, so a line written straight to
 * stdout would land in the middle of a box it is drawing. One hook rather than
 * threading a logger through every module: everything here already imports this.
 */
let sink: ((line: string) => void) | null = null;

export function setLogSink(next: ((line: string) => void) | null): void {
  sink = next;
}

function emit(level: 'log' | 'warn' | 'error', line: string, extra?: unknown): void {
  if (sink) {
    sink(extra === undefined || extra === '' ? line : `${line} ${format(extra)}`);
    return;
  }
  console[level](line, extra ?? '');
}

function format(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

export const log = {
  info(msg: string, meta?: Record<string, unknown>): void {
    emit('log', `${ts()} [companion-runner] ${msg}`, meta);
  },
  warn(msg: string, meta?: Record<string, unknown>): void {
    emit('warn', `${ts()} [companion-runner] WARN ${msg}`, meta);
  },
  error(msg: string, err?: unknown): void {
    emit('error', `${ts()} [companion-runner] ERROR ${msg}`, err);
  },
};
