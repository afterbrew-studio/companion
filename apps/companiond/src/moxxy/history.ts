import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HistorySegment, MoxxyEvent } from '@companion/contract';
import { paths } from '../config.js';

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
