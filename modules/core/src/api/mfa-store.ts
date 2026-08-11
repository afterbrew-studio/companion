import type { Database } from '@moxxy/companion-services';

/** One-time MFA recovery codes, stored as SHA-256 digests, never the codes. */
export class MfaStore {
  constructor(private readonly db: Database) {}

  /** Regeneration semantics: the new set always replaces the whole old set. */
  replaceAll(username: string, codeHashes: readonly string[]): void {
    const now = Date.now();
    this.db.prepare(`DELETE FROM mfa_recovery_codes WHERE username = ?`).run(username);
    const insert = this.db.prepare(
      `INSERT INTO mfa_recovery_codes (username, code_hash, created_at) VALUES (?, ?, ?)`,
    );
    for (const hash of codeHashes) insert.run(username, hash, now);
  }

  /** Atomically consume one code: the DELETE either takes the row or misses. */
  consume(username: string, codeHash: string): boolean {
    return (
      this.db
        .prepare(`DELETE FROM mfa_recovery_codes WHERE username = ? AND code_hash = ?`)
        .run(username, codeHash).changes > 0
    );
  }

  count(username: string): number {
    return (
      this.db.prepare(`SELECT COUNT(*) AS n FROM mfa_recovery_codes WHERE username = ?`).get(username) as {
        n: number;
      }
    ).n;
  }

  deleteForUser(username: string): void {
    this.db.prepare(`DELETE FROM mfa_recovery_codes WHERE username = ?`).run(username);
  }
}
