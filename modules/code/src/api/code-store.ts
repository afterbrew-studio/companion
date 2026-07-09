import type Database from 'better-sqlite3';
import type { BaseNotificationKind, NotificationEmitter } from '@companion/core/server';
import type { ServiceMap } from '@companion/contracts';
import type { ReposStore } from './repos-store.js';
import type { IssuesStore } from './issues-store.js';
import type { PrsStore } from './prs-store.js';
import type { TriageStore } from './triage-store.js';
import type { PrReviewsStore } from './pr-reviews-store.js';
import type { PipelinesStore } from './pipelines-store.js';
import type { GithubAccountsStore } from './github-accounts-store.js';
import type { RunsStore } from './operate-types.js';

/**
 * The code domain's view of persistence — a same-shape stand-in for the legacy
 * Store facade so the moved service bodies (accounts/sync/triage/reviews/
 * checks/fixes/pipelines) stay verbatim. Own stores are real instances; the
 * cross-module members are injected: `settings` (module-core), `workspaces`
 * (module-workspace's access-control owner), `runs` (operate's runs store,
 * exposed on its service bundle exactly for this). Reports are a FOREIGN table
 * (the automations domain, not yet carved) — see `ReportsLite`.
 */
export class CodeStore {
  readonly repos: ReposStore;
  readonly issues: IssuesStore;
  readonly prs: PrsStore;
  readonly triage: TriageStore;
  readonly prReviews: PrReviewsStore;
  readonly pipelines: PipelinesStore;
  readonly githubAccounts: GithubAccountsStore;
  readonly settings: { get(key: string): string | null; set(key: string, value: string): void };
  readonly workspaces: ServiceMap['workspace'];
  readonly runs: RunsStore;
  /** Guarded raw-SQL access to the automations-owned reports table. */
  readonly reports: ReportsLite;
  private readonly notify: NotificationEmitter;

  constructor(opts: {
    db: Database.Database;
    repos: ReposStore;
    issues: IssuesStore;
    prs: PrsStore;
    triage: TriageStore;
    prReviews: PrReviewsStore;
    pipelines: PipelinesStore;
    githubAccounts: GithubAccountsStore;
    settings: { get(key: string): string | null; set(key: string, value: string): void };
    workspaces: ServiceMap['workspace'];
    runs: RunsStore;
    notify: NotificationEmitter;
  }) {
    this.repos = opts.repos;
    this.issues = opts.issues;
    this.prs = opts.prs;
    this.triage = opts.triage;
    this.prReviews = opts.prReviews;
    this.pipelines = opts.pipelines;
    this.githubAccounts = opts.githubAccounts;
    this.settings = opts.settings;
    this.workspaces = opts.workspaces;
    this.runs = opts.runs;
    this.reports = new ReportsLite(opts.db);
    this.notify = opts.notify;
  }

  /** Legacy insert shape; the emitter mints id/createdAt, so extras are ignored. */
  readonly notifications = {
    insert: (n: {
      id?: string;
      workspaceId: string | null;
      kind: BaseNotificationKind;
      title: string;
      body?: string;
      href?: string | null;
      createdAt?: number;
    }): void => {
      this.notify.emit({ kind: n.kind, workspaceId: n.workspaceId, title: n.title, body: n.body, href: n.href });
    },
  };
}

/** Minimal report shape this module writes/reads (ci-analysis post-mortems). */
export interface ReportLiteRecord {
  readonly id: string;
  readonly repo: string | null;
  readonly issueNumber: number | null;
  readonly kind: string;
  readonly title: string;
  readonly body: string;
  readonly createdAt: number;
}

/**
 * Lite accessor for the reports table, which belongs to the (not yet carved)
 * automations domain — same guarded raw-SQL pattern as operate-store's repos
 * reads. When automations is absent the table may not exist: inserts drop the
 * report and reads degrade to "no report".
 */
export class ReportsLite {
  constructor(private readonly db: Database.Database) {}

  insert(r: ReportLiteRecord): void {
    try {
      this.db
        .prepare(
          `INSERT INTO reports (id, repo, issue_number, kind, title, body, created_at)
           VALUES (@id, @repo, @issueNumber, @kind, @title, @body, @createdAt)`,
        )
        .run(r);
    } catch {
      // reports table absent (automations module not installed)
    }
  }

  /** Latest report of a kind for a specific issue/PR (ci-analysis lookups). */
  latestFor(repo: string, issueNumber: number, kind: string): ReportLiteRecord | null {
    try {
      const row = this.db
        .prepare(
          `SELECT * FROM reports WHERE repo = ? AND issue_number = ? AND kind = ?
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(repo, issueNumber, kind) as
        | {
            id: string;
            repo: string | null;
            issue_number: number | null;
            kind: string;
            title: string;
            body: string;
            created_at: number;
          }
        | undefined;
      if (!row) return null;
      return {
        id: row.id,
        repo: row.repo,
        issueNumber: row.issue_number,
        kind: row.kind,
        title: row.title,
        body: row.body,
        createdAt: row.created_at,
      };
    } catch {
      return null;
    }
  }
}
