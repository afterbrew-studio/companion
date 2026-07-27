import type Database from 'better-sqlite3';
import type { Role } from '@companion/types';
import { likeArg } from '@companion/services';
import type { UserRecord } from '../contract/index.js';
import type { SessionsStore } from './sessions-store.js';

/** Local user accounts; deleting a user also revokes their sessions. */
export class UsersStore {
  constructor(
    private readonly db: Database.Database,
    private readonly sessions: SessionsStore,
  ) {}

  count(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM users`).get() as { n: number }).n;
  }

  list(): UserRecord[] {
    const rows = this.db.prepare(`SELECT * FROM users ORDER BY created_at`).all() as UserRow[];
    return rows.map(userRowToRecord);
  }

  /** Paged/filtered user listing so the Users view never loads the world. */
  search(opts: { q?: string; role?: string; limit?: number; offset?: number }): { users: UserRecord[]; total: number } {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.q) {
      where.push(`(username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')`);
      const like = likeArg(opts.q);
      args.push(like, like, like);
    }
    if (opts.role) {
      where.push(`role = ?`);
      args.push(opts.role);
    }
    const cond = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM users ${cond}`).get(...args) as { n: number }).n;
    const rows = this.db
      .prepare(`SELECT * FROM users ${cond} ORDER BY created_at LIMIT ? OFFSET ?`)
      .all(...args, opts.limit ?? -1, opts.offset ?? 0) as UserRow[];
    return { users: rows.map(userRowToRecord), total };
  }

  get(username: string): (UserRecord & { passwordHash: string }) | undefined {
    const row = this.db.prepare(`SELECT * FROM users WHERE username = ?`).get(username) as UserRow | undefined;
    if (!row) return undefined;
    return { ...userRowToRecord(row), passwordHash: row.password_hash };
  }

  getByEmail(email: string): (UserRecord & { passwordHash: string }) | undefined {
    const row = this.db.prepare(`SELECT * FROM users WHERE email = ? AND email != '' LIMIT 1`).get(email) as
      | UserRow
      | undefined;
    if (!row) return undefined;
    return { ...userRowToRecord(row), passwordHash: row.password_hash };
  }

  insert(u: { username: string; displayName?: string; email: string; passwordHash: string; role: Role }): void {
    this.db
      .prepare(
        `INSERT INTO users (username, display_name, email, password_hash, role, disabled, created_at)
         VALUES (@username, @displayName, @email, @passwordHash, @role, 0, @createdAt)`,
      )
      .run({ ...u, displayName: u.displayName ?? '', createdAt: Date.now() });
  }

  update(
    username: string,
    fields: { displayName?: string; email?: string; passwordHash?: string; role?: Role; disabled?: boolean },
  ): void {
    this.db
      .prepare(
        `UPDATE users SET
           display_name = COALESCE(@displayName, display_name),
           email = COALESCE(@email, email),
           password_hash = COALESCE(@passwordHash, password_hash),
           role = COALESCE(@role, role),
           disabled = COALESCE(@disabled, disabled)
         WHERE username = @username`,
      )
      .run({
        username,
        displayName: fields.displayName ?? null,
        email: fields.email ?? null,
        passwordHash: fields.passwordHash ?? null,
        role: fields.role ?? null,
        disabled: fields.disabled === undefined ? null : fields.disabled ? 1 : 0,
      });
  }

  delete(username: string): void {
    this.db.prepare(`DELETE FROM users WHERE username = ?`).run(username);
    this.sessions.deleteForUser(username);
  }

  countActiveAdmins(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0`).get() as { n: number })
      .n;
  }
}

interface UserRow {
  username: string;
  display_name: string;
  email: string;
  password_hash: string;
  role: Role;
  disabled: number;
  created_at: number;
}

function userRowToRecord(row: UserRow): UserRecord {
  return {
    username: row.username,
    displayName: row.display_name || row.username,
    email: row.email,
    role: row.role,
    disabled: row.disabled === 1,
    createdAt: row.created_at,
  };
}
