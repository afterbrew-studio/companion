import { legacyNotifications, type NotificationEmitter, type Database } from '@moxxy/companion-sdk/server';
import type { ServiceMap } from '@moxxy/companion-contracts';
import type { ProposalRecord } from '@companion/module-plan/contract';
import type { IssuesStore, PrsStore, ReposStore, RunsStore } from './cross-types.js';

/** The slice of a proposal the workspace briefing reads. */
interface ProposalLite {
  readonly title: string;
  readonly status: ProposalRecord['status'];
}

/**
 * The automations domain's view of persistence — a same-shape stand-in for the
 * legacy Store facade so the moved service bodies (automations/assistant) stay
 * verbatim. This module owns NO tables: everything is injected — `repos` /
 * `issues` / `prs` (module-code's stores, reached through its service bundle),
 * `runs` (operate's runs store, exposed on its bundle exactly for this),
 * `reports` (module-workspace's), `settings` (module-core), `workspaces`
 * (module-workspace's access-control owner) and `notifications` (an adapter
 * over ctx.notify).
 *
 * FLAGGED SEAM — `proposals`: the briefing reads pending proposals, but plan's
 * bundle publishes services only, not its store, and none of them re-expose a
 * workspace listing. Until plan grows one, this is a guarded raw-SQL lite read
 * against the plan-owned `proposals` table (operate-store's repos pattern);
 * plan is a hard dependency so the table exists, and the guard only covers a
 * torn install.
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

  /** See the class doc — a flagged read-only shim over plan's proposals table. */
  readonly proposals = {
    listWorkspace: (workspaceId: string): ProposalLite[] => {
      try {
        return this.db
          .prepare(
            `SELECT title, status FROM proposals WHERE workspace_id = ? ORDER BY created_at DESC`,
          )
          .all(workspaceId) as ProposalLite[];
      } catch {
        return [];
      }
    },
  };

  /** Legacy `notifications.insert({...})` call shape, routed through the shared emitter. */
  readonly notifications = legacyNotifications(() => this.notify);
}
