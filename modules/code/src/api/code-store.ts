import { legacyNotifications, type NotificationEmitter } from '@moxxy/companion-sdk/server';
import type { ServiceMap } from '@moxxy/companion-sdk';
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
 * exposed on its service bundle exactly for this), and `reports`
 * (module-workspace's reports store — this module writes ci-analysis
 * post-mortems through it).
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
  readonly reports: ServiceMap['reports'];
  private readonly notify: NotificationEmitter;

  constructor(opts: {
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
    reports: ServiceMap['reports'];
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
    this.reports = opts.reports;
    this.notify = opts.notify;
  }

  /** Legacy `notifications.insert({...})` call shape, routed through the shared emitter. */
  readonly notifications = legacyNotifications(() => this.notify);
}
