import { currentUser, defineServices } from '@moxxy/companion-sdk/server';
import type { Permission } from '@moxxy/companion-contracts';
import { ReposStore } from './repos-store.js';
import { IssuesStore } from './issues-store.js';
import { PrsStore } from './prs-store.js';
import { TriageStore } from './triage-store.js';
import { PrReviewFindingsStore, PrReviewsStore } from './pr-reviews-store.js';
import { PipelinesStore } from './pipelines-store.js';
import { PipelineSecretsStore } from './pipeline-secrets-store.js';
import { GithubAccountsStore } from './github-accounts-store.js';
import { CodeStore } from './code-store.js';
import { GitHubAccounts } from './github-accounts.js';
import { GitHubSync } from './github-sync.js';
import { PrChecks } from './pr-checks.js';
import { Triage } from './triage.js';
import { PrReviews } from './pr-reviews.js';
import { ReviewChat } from './review-chat.js';
import { Fixes } from './fixes.js';
import { RepoAgentContextScanner } from './repo-agent-context.js';
import { Pipelines, type SlopGateService } from './pipelines.js';
import { CodeService } from './code-service.js';
import { readActiveLocalGhAccount } from './local-gh-account.js';
import { DEFAULT_MAX_PR_REVIEW_TOKENS } from '../contract/index.js';
import {
  buildPrReviewEvaluationPrompt,
  parseVerdictWithFindings,
  PR_REVIEW_PROMPT_VERSION,
} from './pr-reviews.js';
import {
  buildTriageEvaluationPrompt,
  ISSUE_TRIAGE_PROMPT_VERSION,
  parseVerdict as parseTriageVerdict,
} from './triage.js';

/**
 * Construct the GitHub/code domain: the sync-cache stores, the narrow store
 * facade, the personal multi-account registry, request-owned sync + CI checks,
 * and the triage/review/fix/pipeline
 * services — then publish the bundle as `code`. Wiring mirrors the legacy
 * composition root's construction order; the git-credential seam into operate
 * is plugged in at onEnable (jobs.ts), not here.
 */
export default defineServices((ctx) => {
  const settings = ctx.services.get('settings');
  const core = ctx.services.get('core');
  const workspace = ctx.services.get('workspace');
  const operate = ctx.services.get('operate');
  const integrations = ctx.services.get('integrations');

  // The feature tasks this module runs agents for, so runners can block them.
  operate.registerRunTask({ id: 'code.fix', label: 'Fix runs', placeable: true, hint: 'issue fixes and PR repairs — worktree goal runs' });
  operate.registerRunTask({ id: 'code.implement', label: 'Implement runs', placeable: true, hint: 'proposal implementations — worktree goal runs' });
  operate.registerRunTask({ id: 'code.triage', label: 'Issue triage', placeable: false });
  operate.registerRunTask({ id: 'code.pr-review', label: 'PR reviews', placeable: false });
  // Separate from the review itself so a cheaper model can be pinned to it:
  // an in-depth review spawns one of these per serious finding.
  operate.registerRunTask({ id: 'code.review-verify', label: 'Review verification', placeable: false });
  operate.registerRunTask({ id: 'code.review-chat', label: 'Review discussions', placeable: false });
  operate.registerRunTask({ id: 'code.review-reply', label: 'Review replies', placeable: false });
  operate.registerRunTask({ id: 'code.ci-analysis', label: 'CI analyses', placeable: false });
  operate.registerRunTask({ id: 'code.pipeline', label: 'Pipeline agents', placeable: false });
  operate.promptEvaluations.register({
    id: 'code.pr-review',
    moduleId: 'code',
    label: 'Pull request review',
    task: 'code.pr-review',
    version: PR_REVIEW_PROMPT_VERSION,
    buildPrompt: buildPrReviewEvaluationPrompt,
    parseResponse: parseVerdictWithFindings,
  });
  operate.promptEvaluations.register({
    id: 'code.issue-triage',
    moduleId: 'code',
    label: 'Issue triage',
    task: 'code.triage',
    version: ISSUE_TRIAGE_PROMPT_VERSION,
    buildPrompt: buildTriageEvaluationPrompt,
    parseResponse: parseTriageVerdict,
  });

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
  ctx.db
    .prepare(
      `INSERT OR IGNORE INTO repo_workspaces (repo, workspace_id, created_at)
       SELECT full_name, workspace_id, ? FROM repos WHERE workspace_id IS NOT NULL`,
    )
    .run(Date.now());

  // Stores, in the legacy store/db.ts construction order.
  const triageStore = new TriageStore(ctx.db);
  const prReviewsStore = new PrReviewsStore(ctx.db);
  const prReviewFindingsStore = new PrReviewFindingsStore(ctx.db);
  const githubAccountsStore = new GithubAccountsStore(ctx.db);
  const reposStore = new ReposStore(ctx.db, workspace);
  const issuesStore = new IssuesStore(ctx.db, triageStore, githubAccountsStore);
  const prsStore = new PrsStore(ctx.db, prReviewsStore, githubAccountsStore);
  const pipelinesStore = new PipelinesStore(ctx.db);
  const pipelineSecretsStore = new PipelineSecretsStore(ctx.db);

  const store = new CodeStore({
    repos: reposStore,
    issues: issuesStore,
    prs: prsStore,
    triage: triageStore,
    prReviews: prReviewsStore,
    prReviewFindings: prReviewFindingsStore,
    pipelines: pipelinesStore,
    pipelineSecrets: pipelineSecretsStore,
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
  // pipelines, webhooks); consumers resolve a client per purpose and owner.
  // An unowned legacy token is intentionally never adopted.
  // Instance policy for forge mutations. operate owns the policy; code owns the
  // client that would make the write, and code depends on operate, so it is read
  // here rather than pushed in. Attendance comes from the request-scoped invoker,
  // the same signal account resolution already uses to decide who is acting.
  const agentPolicy = ctx.services.get('operate').agentPolicy;
  const ghAccounts = new GitHubAccounts(store, ctx.config.github.apiUrl, (what) =>
    agentPolicy.assertGitHubWrite(currentUser() !== null, what),
  );
  ghAccounts.migrateLegacyToken();
  const importActiveLocalGh = async (): Promise<boolean> => {
    const primaryAdmin = ctx.services.get('core').primaryAdminUsername();
    if (!primaryAdmin) return false;
    const localGh = await readActiveLocalGhAccount(ctx.config.github.host);
    if (!localGh) return false;
    try {
      const connected = await ghAccounts.add(
        localGh.token,
        ['fetch', 'runs', 'pipelines', 'webhooks'],
        primaryAdmin,
        'all',
      );
      ctx.log.info('connected active local gh account to primary admin', {
        githubLogin: connected.login,
        username: primaryAdmin,
      });
      ctx.broadcast({ t: 'repos.changed' });
      return true;
    } catch (err) {
      ctx.log.warn('could not connect active local gh account to primary admin', {
        expectedGithubLogin: localGh.login,
        username: primaryAdmin,
        err: String(err),
      });
      return false;
    }
  };

  const sync = new GitHubSync(
    store,
    async (repo, workspaceId, username) => {
      const { client } = await ghAccounts.verifiedClientFor('fetch', repo, { workspaceId, username });
      return client;
    },
    ctx.broadcast,
  );
  const prChecks = new PrChecks(
    store,
    (repo, username) => ghAccounts.clientFor('fetch', { repo, username }),
    ctx.broadcast,
  );
  // Every sync also refreshes CI snapshots for the repo's freshest open PRs.
  sync.onSynced = (repo, username) => prChecks.refreshOpenPrs(repo, username);

  const authorized = (username: string, permission: Permission, repo: string): boolean => {
    const role = core.activeUserRole(username);
    return role !== undefined &&
      ctx.rbac.has(role, permission) &&
      workspace.canAccessRepo({ username, displayName: username, role }, repo);
  };

  const integrationScope = (username: string, repo: string, requestedWorkspaceId?: string) => {
    const role = core.activeUserRole(username);
    if (!role) throw new Error(`${username} is disabled`);
    const user = { username, displayName: username, role };
    const candidates = requestedWorkspaceId ? [requestedWorkspaceId] : reposStore.workspaceIds(repo);
    const workspaceId = candidates.find(
      (id) => reposStore.inWorkspace(repo, id) && workspace.canAccessWorkspace(user, id),
    );
    if (!workspaceId) throw new Error(`repository ${repo} is not available in the requested workspace`);
    return { kind: 'repository' as const, workspaceId, repo };
  };

  const triage = new Triage(
    store,
    operate.orchestrator,
    operate.checkouts,
    (c) => ghAccounts.clientFor('pipelines', c),
    authorized,
    ctx.broadcast,
  );
  const prReviews = new PrReviews(
    store,
    operate.orchestrator,
    operate.checkouts,
    (runId) => operate.usageForRun(runId),
    () => {
      const value = ctx.moduleConfig.get('maxPrReviewTokens');
      return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.floor(value)
        : DEFAULT_MAX_PR_REVIEW_TOKENS;
    },
    (c) => ghAccounts.clientFor('pipelines', c),
    // Merging is a write action: skip accounts that can only read the repo
    // rather than burning a failover round on a guaranteed 403.
    (repo, prNumber, method, c) =>
      ghAccounts.performForRepo(
        'pipelines',
        repo,
        async (client) => {
          const fresh = await client.pull(repo, prNumber);
          return client.mergePr(repo, prNumber, method, fresh.head.sha);
        },
        { ...c, need: 'push' },
    ),
    prChecks,
    authorized,
    ctx.broadcast,
    integrations,
    integrationScope,
  );
  const reviewChat = new ReviewChat(store, operate.orchestrator, operate.checkouts, authorized, ctx.broadcast);
  const agentContext = new RepoAgentContextScanner();
  const fixes = new Fixes(
    store,
    operate.orchestrator,
    (repo, username) =>
      ghAccounts.clientFor(
        'runs',
        repo
          ? { repo, ...(username === undefined ? {} : { username }) }
          : username === undefined
            ? undefined
            : { username },
      ),
    async (repo, username) =>
      (await ghAccounts.verifiedClientFor('runs', repo, { username })).client !== null,
    (repo, username) => ghAccounts.verifiedClientFor('runs', repo, { username, need: 'push' }),
    authorized,
    prChecks,
    agentContext,
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
      fixes,
      // Reverse-direction soft dep: module-slop augments ServiceMap in ITS
      // contract, which code cannot import (slop dependsOn code) — so the key
      // is invisible to this compilation and the lookup goes through a cast.
      // The structural SlopGateService seam keeps the shape honest.
      slop: () =>
        ((ctx.services.tryGet.bind(ctx.services) as (key: string) => unknown)('slop') as
          | SlopGateService
          | undefined) ?? null,
      // Reads this module's own declared config INCLUDING its secret fields:
      // redaction happens at the HTTP boundary, not here. That is the whole
      // reason a step can resolve a token the client can never read back.
      moduleConfig: ctx.moduleConfig,
      // Values for hidden step variables, under keys this module invents. Same
      // backend as the declared secret fields, so a Vault swap carries both.
      secrets: ctx.secrets,
      audit: (event) => ctx.audit.record({ at: Date.now(), module: 'code', ...event }),
      authorized,
      canAccessWorkspace: (username, workspaceId) => {
        const role = core.activeUserRole(username);
        return role !== undefined &&
          workspace.canAccessWorkspace({ username, displayName: username, role }, workspaceId);
      },
    },
    ctx.broadcast,
  );

  const code = new CodeService(
    reposStore,
    issuesStore,
    prsStore,
    ghAccounts,
    sync,
    triage,
    prReviews,
    reviewChat,
    prChecks,
    agentContext,
    fixes,
    pipelines,
    importActiveLocalGh,
  );
  ctx.services.register('code', code);
  // Host integration is opportunistic and must never delay the daemon boot.
  // The account page refreshes from repos.changed once validation completes.
  void code.importLocalGhAccount();
});
