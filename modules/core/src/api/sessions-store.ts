import type { Database } from '@moxxy/companion-services';
import type { SessionAccess } from '@moxxy/companion-contracts';
import type { Role } from '@moxxy/companion-types';

interface SessionRow {
  id: string;
  token_hash: string;
  username: string;
  role: Role;
  access: string;
  created_at: number;
  last_seen_at: number | null;
  expires_at: number;
}

export interface StoredSession {
  readonly id: string;
  readonly tokenHash: string;
  readonly username: string;
  readonly role: Role;
  readonly access: SessionAccess;
  readonly createdAt: number;
  readonly lastSeenAt: number | null;
  readonly expiresAt: number;
}

/** Login sessions, keyed by token hash — raw tokens never touch the disk. */
export class SessionsStore {
  constructor(private readonly db: Database) {}

  insert(s: {
    id: string;
    tokenHash: string;
    username: string;
    role: Role;
    access: SessionAccess;
    createdAt: number;
    expiresAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, token_hash, username, role, access, created_at, expires_at)
         VALUES (@id, @tokenHash, @username, @role, @access, @createdAt, @expiresAt)`,
      )
      .run(s);
  }

  get(tokenHash: string): StoredSession | null {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE token_hash = ?`).get(tokenHash) as
      | SessionRow
      | undefined;
    return row ? rowToSession(row) : null;
  }

  /** Live sessions for the inventory views, newest first. */
  listForUser(username: string): StoredSession[] {
    const rows = this.db
      .prepare(`SELECT * FROM sessions WHERE username = ? AND expires_at > ? ORDER BY created_at DESC`)
      .all(username, Date.now()) as SessionRow[];
    return rows.map(rowToSession);
  }

  /** Stamp activity; verify() throttles calls to at most one per minute per session. */
  touch(tokenHash: string, at: number): void {
    this.db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?`).run(at, tokenHash);
  }

  delete(tokenHash: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(tokenHash);
  }

  /** Scoped to the owner so a guessed id can never revoke someone else's session. */
  deleteByIdForUser(username: string, id: string): boolean {
    return this.db.prepare(`DELETE FROM sessions WHERE id = ? AND username = ?`).run(id, username).changes > 0;
  }

  pruneExpired(): void {
    this.db.prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(Date.now());
  }

  deleteForUser(username: string): number {
    return this.db.prepare(`DELETE FROM sessions WHERE username = ?`).run(username).changes;
  }
}

function rowToSession(row: SessionRow): StoredSession {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    username: row.username,
    role: row.role,
    // The migration gives every legacy row the exact value `full`. Anything
    // malformed after that fails closed instead of silently widening it.
    access: row.access === 'full' ? 'full' : 'read-only',
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
  };
}
