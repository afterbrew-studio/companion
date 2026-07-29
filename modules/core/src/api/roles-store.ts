import type { Database } from '@moxxy/companion-services';
import type { RoleOverride, RoleOverrides } from '@moxxy/companion-core/server';
import type { RoleRecord } from '../contract/index.js';

interface RoleRow {
  id: string;
  title: string;
  description: string;
  builtin: number;
  created_at: number;
}

const rowToRole = (r: RoleRow): RoleRecord => ({
  id: r.id,
  title: r.title,
  description: r.description,
  builtin: r.builtin === 1,
  createdAt: r.created_at,
});

/**
 * Owner of `roles` and `role_permissions`. Override rows are kept even when the
 * permission's module is disabled: the grid filters them out while it is off and
 * restores them when it comes back, so a disable never quietly discards an
 * admin's configuration.
 */
export class RolesStore {
  constructor(private readonly db: Database) {}

  list(): RoleRecord[] {
    return (this.db.prepare(`SELECT * FROM roles ORDER BY builtin DESC, id`).all() as RoleRow[]).map(rowToRole);
  }

  get(id: string): RoleRecord | null {
    const row = this.db.prepare(`SELECT * FROM roles WHERE id = ?`).get(id) as RoleRow | undefined;
    return row ? rowToRole(row) : null;
  }

  create(input: { id: string; title: string; description?: string }): void {
    this.db
      .prepare(`INSERT INTO roles (id, title, description, builtin, created_at) VALUES (?, ?, ?, 0, ?)`)
      .run(input.id, input.title, input.description ?? '', Date.now());
  }

  delete(id: string): void {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM role_permissions WHERE role_id = ?`).run(id);
      this.db.prepare(`DELETE FROM roles WHERE id = ?`).run(id);
    })();
  }

  /** Upsert: a permission carries at most one override per role, grant or revoke. */
  setOverride(role: string, permission: string, mode: 'grant' | 'revoke'): void {
    this.db
      .prepare(
        `INSERT INTO role_permissions (role_id, permission, mode, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(role_id, permission) DO UPDATE SET mode = excluded.mode, created_at = excluded.created_at`,
      )
      .run(role, permission, mode, Date.now());
  }

  clearOverride(role: string, permission: string): void {
    this.db.prepare(`DELETE FROM role_permissions WHERE role_id = ? AND permission = ?`).run(role, permission);
  }

  overridesFor(role: string): RoleOverride[] {
    return this.db
      .prepare(`SELECT role_id, permission, mode FROM role_permissions WHERE role_id = ?`)
      .all(role)
      .map((r) => {
        const row = r as { role_id: string; permission: string; mode: 'grant' | 'revoke' };
        return { role: row.role_id, permission: row.permission, mode: row.mode } as RoleOverride;
      });
  }

  /** The whole picture the grid folds: known roles plus every override row. */
  snapshot(): RoleOverrides {
    const roles = (this.db.prepare(`SELECT id FROM roles`).all() as { id: string }[]).map((r) => r.id);
    const entries = (
      this.db.prepare(`SELECT role_id, permission, mode FROM role_permissions`).all() as {
        role_id: string;
        permission: string;
        mode: 'grant' | 'revoke';
      }[]
    ).map((r) => ({ role: r.role_id, permission: r.permission, mode: r.mode }) as RoleOverride);
    return { roles, entries };
  }

  countUsers(role: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = ?`).get(role) as { n: number }).n;
  }
}
