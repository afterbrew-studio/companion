import type { Database } from '@moxxy/companion-services';
import type { RunKind } from '../contract/index.js';

/** A persisted queue entry: enough to re-dispatch the work after a restart. */
export interface PersistedQueueEntry {
  readonly id: string;
  readonly kind: RunKind;
  readonly title: string;
  readonly repo: string | null;
  readonly issueNumber: number | null;
  readonly priority: number;
  /** Which registered resumer runs it, and the args to pass. */
  readonly resumeType: string;
  readonly resumeArgs: Record<string, unknown>;
  readonly enqueuedAt: number;
}

/**
 * Durable mirror of the orchestrator's waiting run queue. The in-memory queue
 * is authoritative while the daemon lives; this table lets waiting work survive
 * a restart — on boot the orchestrator reads it and re-dispatches each entry.
 * Only entries that carry a resumer are stored (others can't be replayed).
 */
export class RunQueueStore {
  constructor(private readonly db: Database) {}

  /** Rewrite the whole queue in order — cheap (the waiting list is small). */
  replaceAll(entries: readonly PersistedQueueEntry[]): void {
    const tx = this.db.transaction((rows: readonly PersistedQueueEntry[]) => {
      this.db.prepare(`DELETE FROM run_queue`).run();
      const insert = this.db.prepare(
        `INSERT INTO run_queue (id, position, kind, title, repo, issue_number, priority, resume_type, resume_args, enqueued_at)
         VALUES (@id, @position, @kind, @title, @repo, @issueNumber, @priority, @resumeType, @resumeArgs, @enqueuedAt)`,
      );
      rows.forEach((e, position) =>
        insert.run({
          id: e.id,
          position,
          kind: e.kind,
          title: e.title,
          repo: e.repo,
          issueNumber: e.issueNumber,
          priority: e.priority,
          resumeType: e.resumeType,
          resumeArgs: JSON.stringify(e.resumeArgs),
          enqueuedAt: e.enqueuedAt,
        }),
      );
    });
    tx(entries);
  }

  /** Waiting entries in queue order (for restart replay). */
  list(): PersistedQueueEntry[] {
    const rows = this.db.prepare(`SELECT * FROM run_queue ORDER BY position ASC`).all() as Array<{
      id: string;
      kind: string;
      title: string;
      repo: string | null;
      issue_number: number | null;
      priority: number;
      resume_type: string;
      resume_args: string;
      enqueued_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind as RunKind,
      title: r.title,
      repo: r.repo,
      issueNumber: r.issue_number,
      priority: r.priority,
      resumeType: r.resume_type,
      resumeArgs: safeParse(r.resume_args),
      enqueuedAt: r.enqueued_at,
    }));
  }

  clear(): void {
    this.db.prepare(`DELETE FROM run_queue`).run();
  }
}

function safeParse(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
