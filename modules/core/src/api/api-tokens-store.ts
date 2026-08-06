import type { Permission } from '@moxxy/companion-contracts';
import type { Database } from '@moxxy/companion-services';
import type { ApiTokenRecord } from '../contract/index.js';

/** Persisted API credentials. Only a SHA-256 digest reaches SQLite. */
export class ApiTokensStore {
  constructor(private readonly db: Database) {}

  insert(token: ApiTokenRecord & { readonly tokenHash: string }): void {
    this.db
      .prepare(
        `INSERT INTO api_tokens
           (id, token_hash, username, name, permissions, created_at, expires_at, last_used_at)
         VALUES
           (@id, @tokenHash, @username, @name, @permissions, @createdAt, @expiresAt, @lastUsedAt)`,
      )
      .run({ ...token, permissions: JSON.stringify(token.permissions) });
  }

  getByHash(tokenHash: string): (ApiTokenRecord & { readonly tokenHash: string }) | null {
    const row = this.db.prepare(`SELECT * FROM api_tokens WHERE token_hash = ?`).get(tokenHash) as
      | ApiTokenRow
      | undefined;
    return row ? rowToToken(row) : null;
  }

  get(id: string): ApiTokenRecord | null {
    const row = this.db.prepare(`SELECT * FROM api_tokens WHERE id = ?`).get(id) as ApiTokenRow | undefined;
    return row ? publicToken(rowToToken(row)) : null;
  }

  listForUser(username: string): ApiTokenRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM api_tokens WHERE username = ? AND expires_at > ? ORDER BY created_at DESC`)
      .all(username, Date.now()) as ApiTokenRow[];
    return rows.map((row) => publicToken(rowToToken(row)));
  }

  listAll(opts: { readonly limit: number; readonly offset: number }): {
    readonly tokens: ApiTokenRecord[];
    readonly total: number;
  } {
    const now = Date.now();
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM api_tokens WHERE expires_at > ?`).get(now) as { n: number }
    ).n;
    const rows = this.db
      .prepare(`SELECT * FROM api_tokens WHERE expires_at > ? ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(now, opts.limit, opts.offset) as ApiTokenRow[];
    return { tokens: rows.map((row) => publicToken(rowToToken(row))), total };
  }

  countForUser(username: string): number {
    return (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM api_tokens WHERE username = ? AND expires_at > ?`)
        .get(username, Date.now()) as { n: number }
    ).n;
  }

  touch(tokenHash: string, at: number): void {
    this.db.prepare(`UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?`).run(at, tokenHash);
  }

  delete(id: string): boolean {
    return this.db.prepare(`DELETE FROM api_tokens WHERE id = ?`).run(id).changes > 0;
  }

  deleteForUser(username: string): void {
    this.db.prepare(`DELETE FROM api_tokens WHERE username = ?`).run(username);
  }

  deleteByHash(tokenHash: string): void {
    this.db.prepare(`DELETE FROM api_tokens WHERE token_hash = ?`).run(tokenHash);
  }

  pruneExpired(): number {
    return this.db.prepare(`DELETE FROM api_tokens WHERE expires_at <= ?`).run(Date.now()).changes;
  }
}

interface ApiTokenRow {
  readonly id: string;
  readonly token_hash: string;
  readonly username: string;
  readonly name: string;
  readonly permissions: string;
  readonly created_at: number;
  readonly expires_at: number;
  readonly last_used_at: number | null;
}

function rowToToken(row: ApiTokenRow): ApiTokenRecord & { readonly tokenHash: string } {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    username: row.username,
    name: row.name,
    permissions: parsePermissions(row.permissions),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
  };
}

/** A corrupt scope must fail closed; it must never become an unscoped token. */
function parsePermissions(raw: string): readonly Permission[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) && value.every((item) => typeof item === 'string') ? (value as Permission[]) : [];
  } catch {
    return [];
  }
}

function publicToken(token: ApiTokenRecord & { readonly tokenHash: string }): ApiTokenRecord {
  const { tokenHash: _tokenHash, ...record } = token;
  return record;
}
