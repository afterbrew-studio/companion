import Database from 'better-sqlite3';
import { paths } from '../config.js';
import { migrate } from './migrations.js';
import { SettingsStore } from './settings.js';
import { SessionsStore } from './sessions.js';
import { UsersStore } from './users.js';
import { WorkspacesStore } from './workspaces.js';
import { RunsStore } from './runs.js';
import { ReposStore } from './repos.js';
import { GithubAccountsStore } from './github-accounts.js';
import { TriageStore } from './triage.js';
import { PrReviewsStore } from './pr-reviews.js';
import { IssuesStore } from './issues.js';
import { PrsStore } from './prs.js';
import { ProposalsStore } from './proposals.js';
import { SpecsStore } from './specs.js';
import { DocsStore } from './docs.js';
import { PipelinesStore } from './pipelines.js';
import { ReportsStore } from './reports.js';
import { NotificationsStore } from './notifications.js';
import { RunnersStore } from './runners.js';
import { RunQueueStore } from './run-queue.js';

/**
 * Companion's domain store. Rows are the source of truth for run/proposal
 * lifecycle (gateway processes are cattle). Issues/PRs are a sync cache of
 * GitHub — GitHub stays authoritative; we never mutate the cache except from
 * sync or an applied action.
 *
 * A thin facade: opens the database, runs migrations, and wires one small
 * store class per domain.
 */
export class Store {
  private readonly db: Database.Database;

  public readonly settings: SettingsStore;
  public readonly sessions: SessionsStore;
  public readonly users: UsersStore;
  public readonly workspaces: WorkspacesStore;
  public readonly runs: RunsStore;
  public readonly repos: ReposStore;
  public readonly githubAccounts: GithubAccountsStore;
  public readonly triage: TriageStore;
  public readonly prReviews: PrReviewsStore;
  public readonly issues: IssuesStore;
  public readonly prs: PrsStore;
  public readonly proposals: ProposalsStore;
  public readonly specs: SpecsStore;
  public readonly docs: DocsStore;
  public readonly pipelines: PipelinesStore;
  public readonly reports: ReportsStore;
  public readonly notifications: NotificationsStore;
  public readonly runners: RunnersStore;
  public readonly runQueue: RunQueueStore;

  constructor(file = paths.db()) {
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    const { ftsReady } = migrate(this.db);
    this.settings = new SettingsStore(this.db);
    this.sessions = new SessionsStore(this.db);
    this.users = new UsersStore(this.db, this.sessions);
    this.workspaces = new WorkspacesStore(this.db);
    this.runs = new RunsStore(this.db);
    this.repos = new ReposStore(this.db, this.workspaces);
    this.githubAccounts = new GithubAccountsStore(this.db);
    this.triage = new TriageStore(this.db);
    this.prReviews = new PrReviewsStore(this.db);
    this.issues = new IssuesStore(this.db, this.triage, this.githubAccounts);
    this.prs = new PrsStore(this.db, this.prReviews, this.githubAccounts);
    this.proposals = new ProposalsStore(this.db);
    this.specs = new SpecsStore(this.db);
    this.docs = new DocsStore(this.db, ftsReady);
    this.pipelines = new PipelinesStore(this.db);
    this.reports = new ReportsStore(this.db);
    this.notifications = new NotificationsStore(this.db);
    this.runners = new RunnersStore(this.db);
    this.runQueue = new RunQueueStore(this.db);
    this.workspaces.ensureDefault();
  }

  close(): void {
    this.db.close();
  }
}

export { rowToRun, type RunRow } from './runs.js';
export { rowToRepo, type RepoRow } from './repos.js';
export type { GithubAccountRow } from './github-accounts.js';
export { LOCAL_RUNNER_ID, type RunnerRow } from './runners.js';
