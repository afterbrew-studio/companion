const ts = (): string => new Date().toISOString().slice(11, 23);

export const log = {
  info(msg: string, meta?: Record<string, unknown>): void {
    console.log(`${ts()} [companiond] ${msg}`, meta ?? '');
  },
  warn(msg: string, meta?: Record<string, unknown>): void {
    console.warn(`${ts()} [companiond] WARN ${msg}`, meta ?? '');
  },
  error(msg: string, err?: unknown): void {
    console.error(`${ts()} [companiond] ERROR ${msg}`, err ?? '');
  },
};
