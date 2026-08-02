import { legacyNotifications, type NotificationEmitter, type Database } from '@moxxy/companion-sdk/server';
import type { ServiceMap } from '@moxxy/companion-contracts';
import type { IssuesStore, PrsStore, ReposStore, RunsStore } from './cross-types.js';

/**
 * The automations domain's view of persistence — a same-shape stand-in for the
 * legacy Store facade so the moved service bodies (automations/assistant) stay
 * verbatim. This module owns only the bounded `automation_deliveries`
 * idempotency ledger; domain state is injected — `repos` /
 * `issues` / `prs` (module-code's stores, reached through its service bundle),
 * `runs` (operate's runs store, exposed on its bundle exactly for this),
 * `reports` (module-workspace's), `settings` (module-core), `workspaces`
 * (module-workspace's access-control owner) and `notifications` (an adapter
 * over ctx.notify).
 */
export class AutomationsStore {
  readonly repos: ReposStore;
  readonly issues: IssuesStore;
  readonly prs: PrsStore;
  readonly runs: RunsStore;
  readonly workspaces: ServiceMap['workspace'];
  readonly reports: ServiceMap['reports'];
  readonly settings: { get(key: string): string | null; set(key: string, value: string): void };
  private readonly db: Database;
  private readonly notify: NotificationEmitter;

  constructor(opts: {
    db: Database;
    repos: ReposStore;
    issues: IssuesStore;
    prs: PrsStore;
    runs: RunsStore;
    workspaces: ServiceMap['workspace'];
    reports: ServiceMap['reports'];
    settings: { get(key: string): string | null; set(key: string, value: string): void };
    notify: NotificationEmitter;
  }) {
    this.db = opts.db;
    this.repos = opts.repos;
    this.issues = opts.issues;
    this.prs = opts.prs;
    this.runs = opts.runs;
    this.workspaces = opts.workspaces;
    this.reports = opts.reports;
    this.settings = opts.settings;
    this.notify = opts.notify;
  }

  /** Legacy `notifications.insert({...})` call shape, routed through the shared emitter. */
  readonly notifications = legacyNotifications(() => this.notify);

  /**
   * Claim one GitHub delivery. Completed/recent duplicates are ignored; a
   * processing claim older than ten minutes may be retried after a crash.
   */
  claimDelivery(id: string, repo: string, event: string, now = Date.now()): boolean {
    const staleBefore = now - 10 * 60_000;
    const claim = this.db.transaction(() => {
      const existing = this.db
        .prepare(`SELECT status, received_at FROM automation_deliveries WHERE id = ?`)
        .get(id) as { status: string; received_at: number } | undefined;
      if (existing?.status === 'completed' || (existing && existing.received_at >= staleBefore)) return false;
      this.db
        .prepare(
          `INSERT INTO automation_deliveries (id, repo, event, status, received_at, completed_at)
           VALUES (?, ?, ?, 'processing', ?, NULL)
           ON CONFLICT(id) DO UPDATE SET repo = excluded.repo, event = excluded.event,
             status = 'processing', received_at = excluded.received_at, completed_at = NULL`,
        )
        .run(id, repo, event, now);
      return true;
    });
    const claimed = claim();
    if (claimed) {
      this.db
        .prepare(`DELETE FROM automation_deliveries WHERE received_at < ?`)
        .run(now - 30 * 24 * 60 * 60_000);
    }
    return claimed;
  }

  completeDelivery(id: string): void {
    this.db
      .prepare(`UPDATE automation_deliveries SET status = 'completed', completed_at = ? WHERE id = ?`)
      .run(Date.now(), id);
  }
}
