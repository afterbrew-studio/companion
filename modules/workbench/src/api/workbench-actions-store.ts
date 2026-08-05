import type { Database } from '@moxxy/companion-sdk/server';
import type {
  DecisionSubject,
  PreparedWorkbenchAction,
  WorkbenchActionImpact,
  WorkbenchActionRequest,
  WorkbenchActionResult,
  WorkbenchActionSource,
  WorkbenchActionStatus,
} from '../contract/index.js';

const RETENTION_MS = 30 * 24 * 60 * 60_000;

export interface StoredWorkbenchAction extends PreparedWorkbenchAction {
  /** Exact domain row selected during preparation; never re-resolve to a newer verdict. */
  readonly targetId: string;
  /** Optional optimistic-concurrency fingerprint, such as a pull-request head SHA. */
  readonly targetVersion: string | null;
}

/** Durable proposals and their single-use execution claim. */
export class WorkbenchActionsStore {
  constructor(private readonly db: Database) {}

  insert(action: StoredWorkbenchAction): void {
    this.prune();
    this.db
      .prepare(
        `INSERT INTO workbench_actions (
           id, workspace_id, requested_by, source, action, request, subject,
           target_id, target_version, title, summary, consequence, impact, href,
           status, created_at, expires_at, executed_at, error, result
         ) VALUES (
           @id, @workspaceId, @requestedBy, @source, @action, @request, @subject,
           @targetId, @targetVersion, @title, @summary, @consequence, @impact, @href,
           @status, @createdAt, @expiresAt, @executedAt, @error, @result
         )`,
      )
      .run({
        ...action,
        action: action.request.action,
        request: JSON.stringify(action.request),
        subject: JSON.stringify(action.subject),
        result: action.result ? JSON.stringify(action.result) : null,
      });
  }

  get(id: string): StoredWorkbenchAction | null {
    const row = this.db.prepare(`SELECT * FROM workbench_actions WHERE id = ?`).get(id) as ActionRow | undefined;
    return row ? rowToAction(row) : null;
  }

  list(
    username: string,
    opts: { readonly workspaceId?: string; readonly status?: WorkbenchActionStatus; readonly limit?: number } = {},
  ): StoredWorkbenchAction[] {
    this.expire();
    const where = ['requested_by = ?'];
    const args: unknown[] = [username];
    if (opts.workspaceId) {
      where.push('workspace_id = ?');
      args.push(opts.workspaceId);
    }
    if (opts.status) {
      where.push('status = ?');
      args.push(opts.status);
    }
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
    const rows = this.db
      .prepare(`SELECT * FROM workbench_actions WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`)
      .all(...args, limit) as ActionRow[];
    return rows.map(rowToAction);
  }

  pendingCount(username: string): number {
    this.expire();
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM workbench_actions WHERE requested_by = ? AND status = 'pending'`)
      .get(username) as { count: number };
    return row.count;
  }

  /** Atomically gives one request the right to execute this still-current proposal. */
  claim(id: string, username: string): boolean {
    this.expire();
    return (
      this.db
        .prepare(
          `UPDATE workbench_actions SET status = 'executing', error = NULL
           WHERE id = ? AND requested_by = ? AND status = 'pending' AND expires_at > ?`,
        )
        .run(id, username, Date.now()).changes === 1
    );
  }

  complete(id: string, result: WorkbenchActionResult): void {
    this.db
      .prepare(`UPDATE workbench_actions SET status = 'completed', result = ?, executed_at = ? WHERE id = ?`)
      .run(JSON.stringify(result), Date.now(), id);
  }

  fail(id: string, error: string): void {
    this.db
      .prepare(`UPDATE workbench_actions SET status = 'failed', error = ?, executed_at = ? WHERE id = ?`)
      .run(error.slice(0, 1000), Date.now(), id);
  }

  cancel(id: string, username: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE workbench_actions SET status = 'cancelled'
           WHERE id = ? AND requested_by = ? AND status = 'pending'`,
        )
        .run(id, username).changes === 1
    );
  }

  expire(now = Date.now()): number {
    return this.db
      .prepare(`UPDATE workbench_actions SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?`)
      .run(now).changes;
  }

  /** A daemon death during a write is ambiguous, so recovery never retries it. */
  failInterrupted(): number {
    return this.db
      .prepare(
        `UPDATE workbench_actions
         SET status = 'failed', error = 'execution was interrupted; verify the target before trying again', executed_at = ?
         WHERE status = 'executing'`,
      )
      .run(Date.now()).changes;
  }

  private prune(): void {
    this.db
      .prepare(
        `DELETE FROM workbench_actions WHERE id IN (
           SELECT id FROM workbench_actions
           WHERE created_at < ? AND status != 'executing'
           ORDER BY created_at LIMIT 10000
         )`,
      )
      .run(Date.now() - RETENTION_MS);
  }
}

interface ActionRow {
  id: string;
  workspace_id: string;
  requested_by: string;
  source: string;
  action: string;
  request: string;
  subject: string;
  target_id: string;
  target_version: string | null;
  title: string;
  summary: string;
  consequence: string;
  impact: string;
  href: string;
  status: string;
  created_at: number;
  expires_at: number;
  executed_at: number | null;
  error: string | null;
  result: string | null;
}

function rowToAction(row: ActionRow): StoredWorkbenchAction {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    requestedBy: row.requested_by,
    source: row.source as WorkbenchActionSource,
    request: JSON.parse(row.request) as WorkbenchActionRequest,
    subject: JSON.parse(row.subject) as DecisionSubject,
    targetId: row.target_id,
    targetVersion: row.target_version,
    title: row.title,
    summary: row.summary,
    consequence: row.consequence,
    impact: row.impact as WorkbenchActionImpact,
    href: row.href,
    status: row.status as WorkbenchActionStatus,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    executedAt: row.executed_at,
    error: row.error,
    result: row.result ? (JSON.parse(row.result) as WorkbenchActionResult) : null,
  };
}
