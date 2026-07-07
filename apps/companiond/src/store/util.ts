// Shared SQL/JSON helpers for the store's domain classes.

/** Escape %/_ so user input matches literally in LIKE queries. */
export function likeArg(q: string): string {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

export function safeParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
