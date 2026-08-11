import type { Database } from '@moxxy/companion-sdk/server';

/**
 * The store is handed the daemon's own database handle through `ctx.db`. A
 * module never opens a second connection: that would sit outside the daemon's
 * WAL and transaction discipline.
 */
export class GreetingStore {
  constructor(private readonly db: Database) {}

  record(name: string): void {
    this.db.prepare(`INSERT INTO hello_greetings (name, created_at) VALUES (?, ?)`).run(name, Date.now());
  }

  total(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM hello_greetings`).get() as { n: number };
    return row.n;
  }
}
