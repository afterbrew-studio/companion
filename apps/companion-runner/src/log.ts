const ts = (): string => new Date().toISOString().slice(11, 23);

export const log = {
  info(msg: string, meta?: Record<string, unknown>): void {
    console.log(`${ts()} [companion-runner] ${msg}`, meta ?? '');
  },
  warn(msg: string, meta?: Record<string, unknown>): void {
    console.warn(`${ts()} [companion-runner] WARN ${msg}`, meta ?? '');
  },
  error(msg: string, err?: unknown): void {
    console.error(`${ts()} [companion-runner] ERROR ${msg}`, err ?? '');
  },
};
