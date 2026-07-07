import type Database from 'better-sqlite3';
import type { GitHubPurpose } from '@companion/contract';

/** Connected GitHub accounts (PATs) and what each one is used for. */
export class GithubAccountsStore {
  constructor(private readonly db: Database.Database) {}

  insert(a: { id: string; login: string; token: string; purposes: readonly string[]; createdAt: number }): void {
    this.db
      .prepare(
        `INSERT INTO github_accounts (id, login, token, purposes, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(a.id, a.login, a.token, JSON.stringify(a.purposes), a.createdAt);
  }

  /** Internal rows including tokens — never returned by the API layer. */
  list(): GithubAccountRow[] {
    const rows = this.db.prepare(`SELECT * FROM github_accounts ORDER BY created_at`).all() as Array<{
      id: string;
      login: string;
      token: string;
      purposes: string;
      created_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      login: r.login,
      token: r.token,
      purposes: JSON.parse(r.purposes) as GitHubPurpose[],
      createdAt: r.created_at,
    }));
  }

  update(id: string, fields: { login?: string; token?: string; purposes?: readonly string[] }): void {
    this.db
      .prepare(
        `UPDATE github_accounts SET
           login = COALESCE(?, login),
           token = COALESCE(?, token),
           purposes = COALESCE(?, purposes)
         WHERE id = ?`,
      )
      .run(fields.login ?? null, fields.token ?? null, fields.purposes ? JSON.stringify(fields.purposes) : null, id);
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM github_accounts WHERE id = ?`).run(id);
  }

  /** Logins of the connected GitHub accounts — the identity behind "__me" filters. */
  logins(): string[] {
    return this.list().map((a) => a.login);
  }
}

export interface GithubAccountRow {
  id: string;
  login: string;
  token: string;
  purposes: GitHubPurpose[];
  createdAt: number;
}
