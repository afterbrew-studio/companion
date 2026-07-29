import type { Database } from '@moxxy/companion-sdk/server';
import type { NotificationRecord } from '../contract/index.js';

// Fresh workspace/platform notifications use an explicit non-repo sentinel.
// NULL is reserved for rows written before repo access was enforced and those
// rows fail closed in list(); their contents cannot be scoped reliably.
const NON_REPO_SCOPE = '@workspace';

/** The notification inbox — bounded to 30 days, workspace-scoped or instance-wide. */
export class NotificationsStore {
  constructor(private readonly db: Database) {}

  insert(n: Omit<NotificationRecord, 'readAt'>): void {
    this.db
      .prepare(
        `INSERT INTO notifications (id, workspace_id, repo, kind, title, body, href, created_at)
         VALUES (@id, @workspaceId, @repo, @kind, @title, @body, @href, @createdAt)`,
      )
      .run({ ...n, repo: n.repo ?? NON_REPO_SCOPE });
    // Keep the inbox bounded — anything past 30 days is stale.
    this.db.prepare(`DELETE FROM notifications WHERE created_at < ?`).run(Date.now() - 30 * 24 * 3600_000);
  }

  /**
   * Notifications the caller may see, newest first: a specific workspace's rows
   * plus instance-wide (NULL) rows, or — with no specific workspace — the
   * instance-wide rows plus every accessible workspace's. `accessibleIds`
   * undefined means "unrestricted" (admin/internal); an empty array means only
   * instance-wide rows.
   */
  list(
    workspaceId: string | null | undefined,
    limit = 100,
    accessibleIds?: readonly string[],
  ): NotificationRecord[] {
    let rows: unknown[];
    if (workspaceId) {
      rows = this.db
        .prepare(
          `SELECT * FROM notifications WHERE repo IS NOT NULL AND (workspace_id = ? OR workspace_id IS NULL)
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(workspaceId, limit);
    } else if (accessibleIds === undefined) {
      rows = this.db.prepare(`SELECT * FROM notifications WHERE repo IS NOT NULL ORDER BY created_at DESC LIMIT ?`).all(limit);
    } else {
      const placeholders = accessibleIds.map(() => '?').join(', ');
      const cond = accessibleIds.length > 0 ? `OR workspace_id IN (${placeholders})` : '';
      rows = this.db
        .prepare(`SELECT * FROM notifications WHERE repo IS NOT NULL AND (workspace_id IS NULL ${cond}) ORDER BY created_at DESC LIMIT ?`)
        .all(...accessibleIds, limit);
    }
    return (rows as NotificationRow[]).map(rowToNotification);
  }

  markRead(id: string): void {
    this.db.prepare(`UPDATE notifications SET read_at = ? WHERE id = ? AND read_at IS NULL`).run(Date.now(), id);
  }

  markAllRead(workspaceId: string | null | undefined, accessibleIds?: readonly string[]): void {
    const now = Date.now();
    if (workspaceId) {
      this.db
        .prepare(
          `UPDATE notifications SET read_at = ? WHERE read_at IS NULL AND (workspace_id = ? OR workspace_id IS NULL)`,
        )
        .run(now, workspaceId);
    } else if (accessibleIds === undefined) {
      this.db.prepare(`UPDATE notifications SET read_at = ? WHERE read_at IS NULL`).run(now);
    } else {
      const placeholders = accessibleIds.map(() => '?').join(', ');
      const cond = accessibleIds.length > 0 ? `OR workspace_id IN (${placeholders})` : '';
      this.db
        .prepare(`UPDATE notifications SET read_at = ? WHERE read_at IS NULL AND (workspace_id IS NULL ${cond})`)
        .run(now, ...accessibleIds);
    }
  }
}

interface NotificationRow {
  id: string;
  workspace_id: string | null;
  repo: string | null;
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
    repo: row.repo === NON_REPO_SCOPE ? null : row.repo,
    kind: row.kind as NotificationRecord['kind'],
    title: row.title,
    body: row.body,
    href: row.href,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}
