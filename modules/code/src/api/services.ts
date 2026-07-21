import { defineServices } from '@companion/core/server';
import { ReposStore } from './repos-store.js';
import { IssuesStore } from './issues-store.js';
import { PrsStore } from './prs-store.js';
import { TriageStore } from './triage-store.js';
import { PrReviewsStore } from './pr-reviews-store.js';
import { PipelinesStore } from './pipelines-store.js';
import { GithubAccountsStore } from './github-accounts-store.js';
import { CodeStore } from './code-store.js';
import { GitHubAccounts } from './github-accounts.js';
import { GitHubSync } from './github-sync.js';
import { PrChecks } from './pr-checks.js';
import { Triage } from './triage.js';
import { PrReviews } from './pr-reviews.js';
import { Fixes } from './fixes.js';
import { Pipelines, type SlopGateService } from './pipelines.js';
import { CodeService } from './code-service.js';

/**
 * Construct the GitHub/code domain: the sync-cache stores, the narrow store
 * facade, the multi-account registry (adopting the legacy single PAT on first
 * boot), the poller + CI-checks pair, and the triage/review/fix/pipeline
 * services — then publish the bundle as `code`. Wiring mirrors the legacy
 * composition root's construction order; the git-credential seam into operate
 * is plugged in at onEnable (jobs.ts), not here.
 */
export default defineServices((ctx) => {
  const settings = ctx.services.get('settings');
  const workspace = ctx.services.get('workspace');
  const operate = ctx.services.get('operate');

  // Adopt orphan repos into the oldest workspace — the legacy second half of
  // workspace's ensureDefault(), relocated to the repos owner (our migration
  // has just run, and workspace's table migrated before ours in topo order).
  ctx.db
    .prepare(
      `UPDATE repos SET workspace_id =
         (SELECT id FROM workspaces ORDER BY created_at LIMIT 1)
       WHERE workspace_id IS NULL`,
    )
    .run();

  // Stores, in the legacy store/db.ts construction order.
  const triageStore = new TriageStore(ctx.db);
  const prReviewsStore = new PrReviewsStore(ctx.db);
  const githubAccountsStore = new GithubAccountsStore(ctx.db);
  const reposStore = new ReposStore(ctx.db, workspace);
  const issuesStore = new IssuesStore(ctx.db, triageStore, githubAccountsStore);
  const prsStore = new PrsStore(ctx.db, prReviewsStore, githubAccountsStore);
  const pipelinesStore = new PipelinesStore(ctx.db);

  const store = new CodeStore({
    repos: reposStore,
    issues: issuesStore,
    prs: prsStore,
    triage: triageStore,
    prReviews: prReviewsStore,
    pipelines: pipelinesStore,
    githubAccounts: githubAccountsStore,
    settings,
    workspaces: workspace,
    runs: operate.runsStore,
    // module-workspace registers below code in the dependency order, so the
    // reports store is always present when code is enabled.
    reports: ctx.services.get('reports'),
    notify: ctx.notify,
  });

  // GitHub accounts registry: each PAT is bound to purposes (fetch, runs,
  // pipelines, webhooks); consumers resolve a client per purpose. The legacy
  // single settings-table token migrates into the registry on first boot.
  const ghAccounts = new GitHubAccounts(store);
  ghAccounts.migrateLegacyToken();

  const sync = new GitHubSync(store, (repo) => ghAccounts.clientFor('fetch', { repo }), ctx.broadcast);
  const prChecks = new PrChecks(store, (repo) => ghAccounts.clientFor('fetch', { repo }), ctx.broadcast);
  // Every sync also refreshes CI snapshots for the repo's freshest open PRs.
  sync.onSynced = (repo) => prChecks.refreshOpenPrs(repo);

  const triage = new Triage(
    store,
    operate.orchestrator,
    operate.checkouts,
    (c) => ghAccounts.clientFor('pipelines', c),
    ctx.broadcast,
  );
  const prReviews = new PrReviews(
    store,
    operate.orchestrator,
    operate.checkouts,
    (c) => ghAccounts.clientFor('pipelines', c),
    prChecks,
    ctx.broadcast,
  );
  const fixes = new Fixes(
    store,
    operate.orchestrator,
    (repo) => ghAccounts.clientFor('runs', repo ? { repo } : undefined),
    prChecks,
    ctx.broadcast,
  );
  const pipelines = new Pipelines(
    {
      store,
      orchestrator: operate.orchestrator,
      checkouts: operate.checkouts,
      github: (c) => ghAccounts.clientFor('pipelines', c),
      checks: prChecks,
      reviews: prReviews,
      // Reverse-direction soft dep: module-slop augments ServiceMap in ITS
      // contract, which code cannot import (slop dependsOn code) — so the key
      // is invisible to this compilation and the lookup goes through a cast.
      // The structural SlopGateService seam keeps the shape honest.
      slop: () =>
        ((ctx.services.tryGet.bind(ctx.services) as (key: string) => unknown)('slop') as
          | SlopGateService
          | undefined) ?? null,
    },
    ctx.broadcast,
  );

  ctx.services.register(
    'code',
    new CodeService(reposStore, issuesStore, prsStore, ghAccounts, sync, triage, prReviews, prChecks, fixes, pipelines),
  );
});
