import type { Database } from '@moxxy/companion-sdk/server';
import type { NotificationRecord } from '../contract/index.js';

// Fresh workspace/platform notifications use an explicit non-repo sentinel.
// NULL is reserved for rows written before repo access was enforced and those
// rows fail closed in list(); their contents cannot be scoped reliably.
const NON_REPO_SCOPE = '@workspace';

/** The notification inbox — bounded to 30 days, workspace-scoped or instance-wide. */
export class NotificationsStore {
  private nextPruneAt = 0;

  constructor(private readonly db: Database) {}

  insert(n: Omit<NotificationRecord, 'readAt'>): void {
    this.db
      .prepare(
        `INSERT INTO notifications (id, workspace_id, repo, kind, title, body, href, user_id, created_at)
         VALUES (@id, @workspaceId, @repo, @kind, @title, @body, @href, @userId, @createdAt)`,
      )
      // Bound field by field, not spread: the driver rejects a named parameter
      // the statement does not list, so any caller holding one extra field
      // (`readAt` on a full NotificationRecord) would throw at run time, and
      // the type is too wide to catch it — excess properties only fail on
      // object literals.
      .run({
        id: n.id,
        workspaceId: n.workspaceId,
        repo: n.repo ?? NON_REPO_SCOPE,
        kind: n.kind,
        title: n.title,
        body: n.body,
        href: n.href,
        userId: n.userId,
        createdAt: n.createdAt,
      });
    // Keep the inbox bounded without turning every high-volume insert into a
    // full orphan-receipt scan. One daemon performs the indexed prune at most
    // hourly; a restart merely permits an early harmless pass.
    const now = Date.now();
    if (now >= this.nextPruneAt) {
      const cutoff = now - 30 * 24 * 3600_000;
      this.db.transaction(() => {
        this.db
          .prepare(
            `DELETE FROM notification_reads
             WHERE notification_id IN (SELECT id FROM notifications WHERE created_at < ?)`,
          )
          .run(cutoff);
        this.db.prepare(`DELETE FROM notifications WHERE created_at < ?`).run(cutoff);
      })();
      this.nextPruneAt = now + 60 * 60_000;
    }
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
    /**
     * The reader. An addressed notification is theirs alone; passing undefined
     * keeps the unrestricted internal view. Applied on TOP of workspace scoping
     * rather than instead of it: being named does not grant repo access.
     */
    viewer?: string,
    /** Stable keyset cursor; offset paging would skip rows inserted mid-scan. */
    before?: { readonly createdAt: number; readonly id: string },
  ): NotificationRecord[] {
    const clauses = ['repo IS NOT NULL'];
    const params: Array<string | number> = [];
    if (workspaceId) {
      clauses.push('(workspace_id = ? OR workspace_id IS NULL)');
      params.push(workspaceId);
    } else if (accessibleIds !== undefined) {
      const placeholders = accessibleIds.map(() => '?').join(', ');
      clauses.push(accessibleIds.length > 0 ? `(workspace_id IS NULL OR workspace_id IN (${placeholders}))` : 'workspace_id IS NULL');
      params.push(...accessibleIds);
    }
    if (viewer !== undefined) {
      clauses.push('(user_id IS NULL OR user_id = ?)');
      params.push(viewer);
    }
    if (before) {
      clauses.push('(created_at < ? OR (created_at = ? AND id < ?))');
      params.push(before.createdAt, before.createdAt, before.id);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM notifications WHERE ${clauses.join(' AND ')}
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...params, limit) as NotificationRow[];
    if (viewer === undefined || rows.length === 0) return rows.map(rowToNotification);

    // SQLite builds expose different variable ceilings. Stay comfortably
    // below all of them even when an internal caller asks for a large page.
    const receipts: Array<{ notification_id: string; read_at: number }> = [];
    for (let offset = 0; offset < rows.length; offset += 500) {
      const chunk = rows.slice(offset, offset + 500);
      receipts.push(
        ...(this.db
          .prepare(
            `SELECT notification_id, read_at FROM notification_reads
             WHERE username = ? AND notification_id IN (${chunk.map(() => '?').join(', ')})`,
          )
          .all(viewer, ...chunk.map((row) => row.id)) as Array<{ notification_id: string; read_at: number }>),
      );
    }
    const readAt = new Map(receipts.map((row) => [row.notification_id, row.read_at]));
    return rows.map((row) => rowToNotification(row, readAt.get(row.id) ?? row.read_at));
  }

  get(id: string, viewer: string): NotificationRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM notifications WHERE id = ? AND (user_id IS NULL OR user_id = ?)`)
      .get(id, viewer) as NotificationRow | undefined;
    if (!row) return undefined;
    const receipt = this.db
      .prepare(`SELECT read_at FROM notification_reads WHERE notification_id = ? AND username = ?`)
      .get(id, viewer) as { read_at: number } | undefined;
    return rowToNotification(row, receipt?.read_at ?? row.read_at);
  }

  markRead(id: string, viewer: string): void {
    this.markManyRead([id], viewer);
  }

  markManyRead(ids: readonly string[], viewer: string): void {
    if (ids.length === 0) return;
    const now = Date.now();
    const write = this.db.prepare(
      `INSERT INTO notification_reads (notification_id, username, read_at)
       SELECT id, ?, ? FROM notifications
       WHERE id = ? AND (user_id IS NULL OR user_id = ?)
       ON CONFLICT(notification_id, username) DO UPDATE SET read_at = excluded.read_at`,
    );
    this.db.transaction(() => {
      for (const id of ids) write.run(viewer, now, id, viewer);
    })();
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
  user_id: string | null;
  read_at: number | null;
  created_at: number;
}

function rowToNotification(row: NotificationRow, readAt: number | null = row.read_at): NotificationRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    repo: row.repo === NON_REPO_SCOPE ? null : row.repo,
    kind: row.kind as NotificationRecord['kind'],
    title: row.title,
    body: row.body,
    href: row.href,
    userId: row.user_id,
    readAt,
    createdAt: row.created_at,
  };
}
