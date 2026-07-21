import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HistorySegment, MoxxyEvent } from '@companion/types';
import { paths } from '@companion/services';

/**
 * Transcript history for runs whose gateway has been reaped: read the session's
 * append-only JSONL event log straight from Companion's moxxy home. Corrupt
 * lines are skipped (one bad line must not hide the transcript), matching
 * moxxy's own tolerant readers.
 */
export async function readSessionHistory(
  runId: string,
  before: number | null,
  limit: number,
): Promise<HistorySegment> {
  const file = join(paths.sessions(), `${safeId(runId)}.jsonl`);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return { events: [], prevCursor: null };
  }
  const events: MoxxyEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isEventLike(parsed)) events.push(parsed);
    } catch {
      // tolerate corruption
    }
  }
  const total = events.length;
  const end = before === null ? total : Math.min(before, total);
  const start = Math.max(0, end - limit);
  return { events: events.slice(start, end), prevCursor: start > 0 ? start : null };
}

/**
 * History via the live gateway when it answers promptly, else the session
 * JSONL. A gateway that is mid-turn can sit on the RPC far longer than any
 * caller (the SPA, the hub's HTTP timeout) is willing to wait, while the
 * on-disk log is appended live and holds the same events — so the RPC gets a
 * short deadline, never the transcript.
 */
export async function loadHistoryWithFallback(
  rpc: (() => Promise<HistorySegment>) | null,
  runId: string,
  before: number | null,
  limit: number,
  rpcTimeoutMs = 4_000,
): Promise<HistorySegment> {
  if (rpc) {
    try {
      return await new Promise<HistorySegment>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`history RPC timed out after ${rpcTimeoutMs}ms`)), rpcTimeoutMs);
        rpc().then(
          (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          (e: unknown) => {
            clearTimeout(timer);
            reject(e instanceof Error ? e : new Error(String(e)));
          },
        );
      });
    } catch {
      // fall through to the file
    }
  }
  return readSessionHistory(runId, before, limit);
}

function isEventLike(value: unknown): value is MoxxyEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string'
  );
}

function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_');
}
