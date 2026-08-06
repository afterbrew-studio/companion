import type { Database } from '@moxxy/companion-services';
import type { SessionAccess } from '@moxxy/companion-contracts';
import type { Role } from '@moxxy/companion-types';

/** Login sessions, keyed by token hash — raw tokens never touch the disk. */
export class SessionsStore {
  constructor(private readonly db: Database) {}

  insert(s: {
    tokenHash: string;
    username: string;
    role: Role;
    access: SessionAccess;
    createdAt: number;
    expiresAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO sessions (token_hash, username, role, access, created_at, expires_at)
         VALUES (@tokenHash, @username, @role, @access, @createdAt, @expiresAt)`,
      )
      .run(s);
  }

  get(tokenHash: string): {
    tokenHash: string;
    username: string;
    role: Role;
    access: SessionAccess;
    expiresAt: number;
  } | null {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE token_hash = ?`).get(tokenHash) as
      | { token_hash: string; username: string; role: Role; access: string; expires_at: number }
      | undefined;
    if (!row) return null;
    return {
      tokenHash: row.token_hash,
      username: row.username,
      role: row.role,
      // The migration gives every legacy row the exact value `full`. Anything
      // malformed after that fails closed instead of silently widening it.
      access: row.access === 'full' ? 'full' : 'read-only',
      expiresAt: row.expires_at,
    };
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
