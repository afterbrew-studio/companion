import type { Database, Statement } from '@moxxy/companion-services';
import type { AuditEvent } from '@moxxy/companion-core/server';

/**
 * Owner of `audit_log`. Append-only by design: an audit trail an application can
 * edit is not a trail. Retention and export belong to a dedicated audit module
 * (game plan P6), which takes over by providing its own sink.
 */
export interface AuditRecord {
  readonly id: number;
  readonly at: number;
  readonly actor: string | null;
  readonly action: string;
  readonly access: string;
  readonly status: number;
  readonly module: string | null;
  readonly detail: string | null;
}

export interface AuditQuery {
  readonly actor?: string;
  readonly module?: string;
  readonly since?: number;
  readonly until?: number;
  readonly limit?: number;
  /** Keyset cursor: return rows with a LOWER id than this. */
  readonly before?: number;
}

export class AuditStore {
  private readonly insert: Statement;

  constructor(
    private readonly db: Database,
    /**
     * Optional outbound stream. Injected rather than owned: the table is the
     * source of truth and must be written whether or not a collector exists.
     */
    private readonly forward: (event: AuditEvent) => void = () => {},
  ) {
    this.insert = db.prepare(
      `INSERT INTO audit_log (at, actor, action, access, status, module, detail)
       VALUES (@at, @actor, @action, @access, @status, @module, @detail)`,
    );
  }

  /**
   * Newest first, keyset-paged on `id` rather than OFFSET: an audit table grows
   * without bound between sweeps, and OFFSET makes deep pages scan everything
   * before them. The caller pages by passing the last id it saw.
   */
  list(q: AuditQuery = {}): AuditRecord[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (q.actor) (where.push('actor = ?'), args.push(q.actor));
    if (q.module) (where.push('module = ?'), args.push(q.module));
    if (q.since !== undefined) (where.push('at >= ?'), args.push(q.since));
    if (q.until !== undefined) (where.push('at <= ?'), args.push(q.until));
    if (q.before !== undefined) (where.push('id < ?'), args.push(q.before));
    const cond = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 1000);
    return this.db
      .prepare(`SELECT * FROM audit_log ${cond} ORDER BY id DESC LIMIT ?`)
      .all(...args, limit) as AuditRecord[];
  }

  /**
   * Delete entries older than the window. Bounded per sweep so a table that has
   * grown for a year cannot lock the database in one statement; the daily job
   * simply catches up over a few runs.
   */
  prune(olderThanMs: number, maxRows = 20_000): number {
    return this.db
      .prepare(`DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE at < ? ORDER BY id LIMIT ?)`)
      .run(Date.now() - olderThanMs, maxRows).changes;
  }

  record(event: AuditEvent): void {
    this.insert.run({
      at: event.at,
      actor: event.actor,
      action: event.action,
      access: event.access,
      status: event.status,
      module: event.module,
      detail: event.detail ?? null,
    });
    // After the row, and swallowing: a collector must never be able to fail the
    // write that is the actual record, nor the request being recorded.
    try {
      this.forward(event);
    } catch {
      // The forwarder logs its own failures; it has no business raising here.
    }
  }
}
