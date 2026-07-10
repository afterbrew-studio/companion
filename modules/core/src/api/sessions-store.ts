import type Database from 'better-sqlite3';
import type { Role } from '@companion/types';

/** Login sessions, keyed by token hash — raw tokens never touch the disk. */
export class SessionsStore {
  constructor(private readonly db: Database.Database) {}

  insert(s: { tokenHash: string; username: string; role: Role; createdAt: number; expiresAt: number }): void {
    this.db
      .prepare(
        `INSERT INTO sessions (token_hash, username, role, created_at, expires_at)
         VALUES (@tokenHash, @username, @role, @createdAt, @expiresAt)`,
      )
      .run(s);
  }

  get(tokenHash: string): { tokenHash: string; username: string; role: Role; expiresAt: number } | null {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE token_hash = ?`).get(tokenHash) as
      | { token_hash: string; username: string; role: Role; expires_at: number }
      | undefined;
    if (!row) return null;
    return { tokenHash: row.token_hash, username: row.username, role: row.role, expiresAt: row.expires_at };
  }

  delete(tokenHash: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(tokenHash);
  }

  pruneExpired(): void {
    this.db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(Date.now());
  }

  deleteForUser(username: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE username = ?`).run(username);
  }
}
