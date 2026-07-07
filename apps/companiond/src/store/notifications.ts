import type Database from 'better-sqlite3';
import type { NotificationRecord } from '@companion/contract';

/** The notification inbox — bounded to 30 days, workspace-scoped or instance-wide. */
export class NotificationsStore {
  constructor(private readonly db: Database.Database) {}

  insert(n: Omit<NotificationRecord, 'readAt'>): void {
    this.db
      .prepare(
        `INSERT INTO notifications (id, workspace_id, kind, title, body, href, created_at)
         VALUES (@id, @workspaceId, @kind, @title, @body, @href, @createdAt)`,
      )
      .run(n);
    // Keep the inbox bounded — anything past 30 days is stale.
    this.db.prepare(`DELETE FROM notifications WHERE created_at < ?`).run(Date.now() - 30 * 24 * 3600_000);
  }

  /** Workspace-scoped rows plus instance-wide (NULL workspace) rows, newest first. */
  list(workspaceId: string | null | undefined, limit = 100): NotificationRecord[] {
    const rows = workspaceId
      ? this.db
          .prepare(
            `SELECT * FROM notifications WHERE workspace_id = ? OR workspace_id IS NULL
             ORDER BY created_at DESC LIMIT ?`,
          )
          .all(workspaceId, limit)
      : this.db.prepare(`SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?`).all(limit);
    return (rows as NotificationRow[]).map(rowToNotification);
  }

  markRead(id: string): void {
    this.db.prepare(`UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL`).run(Date.now(), id);
  }

  markAllRead(workspaceId: string | null | undefined): void {
    if (workspaceId) {
      this.db
        .prepare(
          `UPDATE notifications SET read_at = ? WHERE read_at IS NULL AND (workspace_id = ? OR workspace_id IS NULL)`,
        )
        .run(Date.now(), workspaceId);
    } else {
      this.db.prepare(`UPDATE notifications SET read_at = ? WHERE read_at IS NULL`).run(Date.now());
    }
  }
}

interface NotificationRow {
  id: string;
  workspace_id: string | null;
  kind: string;
  title: string;
  body: string;
  href: string | null;
  read_at: number | null;
  created_at: number;
}

function rowToNotification(row: NotificationRow): NotificationRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind as NotificationRecord['kind'],
    title: row.title,
    body: row.body,
    href: row.href,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}
