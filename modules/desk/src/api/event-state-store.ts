import type { Database } from '@moxxy/companion-sdk/server';

/** Latest event projection used only to suppress repeated inbox entries.
 * The durable notification itself remains owned by module-workspace. */
export class DeskEventStateStore {
  constructor(private readonly db: Database) {}

  transition(
    workspaceId: string,
    eventKey: string,
    value: string,
  ): { readonly changed: boolean; readonly previous: string | null } {
    const row = this.db
      .prepare(`SELECT value FROM desk_event_state WHERE workspace_id = ? AND event_key = ?`)
      .get(workspaceId, eventKey) as { value: string } | undefined;
    if (row?.value === value) return { changed: false, previous: row.value };
    this.db
      .prepare(
        `INSERT INTO desk_event_state (workspace_id, event_key, value, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace_id, event_key) DO UPDATE SET
           value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(workspaceId, eventKey, value, Date.now());
    return { changed: true, previous: row?.value ?? null };
  }

  removeForWorkspace(workspaceId: string): number {
    return Number(this.db.prepare(`DELETE FROM desk_event_state WHERE workspace_id = ?`).run(workspaceId).changes);
  }
}
