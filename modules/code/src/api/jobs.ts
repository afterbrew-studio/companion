import { defineJobs, type ModuleContext } from '@moxxy/companion-sdk/server';
import type { TokenRefreshResult } from './github-accounts.js';

let offSetupCompleted: (() => void) | null = null;

/**
 * Surface a credential going bad, and coming back.
 *
 * This is the gap `docs/open-items.md` §1 named: an app uninstalled on GitHub
 * left the account holding a dead token until a human read a log line or a call
 * failed over. Refresh runs every ten minutes, so the emit has to be driven by
 * the TRANSITION the refresh reports, never by the current state, or an outage
 * would post 144 times a day.
 *
 * Instance-wide (no workspace): a credential is not a workspace's property, and
 * scoping it to one would hide it from everybody else.
 */
function announceCredentialHealth(ctx: ModuleContext, result: TokenRefreshResult): void {
  for (const fault of result.started) {
    ctx.notify.emit({
      workspaceId: null,
      kind: 'error',
      title: `GitHub App '${fault.login}' can no longer refresh its token`,
      body:
        `${fault.error ?? 'the refresh failed'}. Agent runs and sync using this account will start failing when the ` +
        'current token expires. Check the app is still installed on the organisation and that its private key is current.',
      href: '#/github-accounts',
    });
  }
  for (const fault of result.recovered) {
    ctx.notify.emit({
      workspaceId: null,
      kind: 'info',
      title: `GitHub App '${fault.login}' is refreshing again`,
      body: 'Its installation token was re-minted successfully.',
      href: '#/github-accounts',
    });
  }
}

/**
 * The cross-module seams, wired at enable time: the account-aware
 * git-credential resolver is PLUGGED INTO the execution plane (inversion of
 * control — operate never imports code), the orchestrator's replay resumers
 * are registered before operate's postActivate resumes the persisted queue,
 * Disable restores operate's fail-closed token source, so a disabled code
 * module cannot leave stale personal credentials reachable.
 */
export default defineJobs({
  onEnable: (ctx) => {
    const code = ctx.services.get('code');
    const operate = ctx.services.get('operate');

    // Git credentials for clones/worktrees/pushes and remote runner agents,
    // resolved per repo and owning profile — and
    // access-VERIFIED when several accounts compete, so the account that can
    // actually see the repo is the one that clones it.
    // Also feeds /api/status with the current request owner's GitHub identity.
    operate.setGithubTokenSource({
      tokenFor: (repo, username, access) =>
        repo
          ? code.githubAccounts.verifiedTokenFor('runs', repo, {
              ...(username === undefined ? {} : { username }),
              // git only knows read vs write; map onto the RBAC ladder here.
              need: access === 'write' ? 'push' : 'pull',
            })
          : (code.githubAccounts.tokenFor('runs', username === undefined ? undefined : { username }) ?? null),
      login: () => code.githubAccounts.loginFor('fetch'),
      // Catalogue, not resolution: a workspace-scoped account is still an
      // account, and the instance health dot must not turn red because of how
      // one is scoped.
      hasAccounts: () => code.githubAccounts.list().length > 0,
    });

    // A clean install has no admin while services boot. First-boot onboarding
    // creates that admin later, so retry the host gh import at that exact
    // lifecycle edge instead of requiring a daemon restart.
    offSetupCompleted = ctx.bus.on('auth.setup.completed', ({ username }) => {
      if (ctx.services.get('core').primaryAdminUsername() !== username) return;
      void code.importLocalGhAccount();
    });

    // Replay unattended work that was still queued when the daemon last
    // stopped (legacy index.ts resumers). Each resumer rebuilds the prompt
    // from stored args and re-enqueues fresh; operate's postActivate calls
    // resumePersistedQueue after ALL modules' onEnable, so these are in place.
    const num = (a: Record<string, unknown>, k: string): number => Number(a[k]);
    const str = (a: Record<string, unknown>, k: string): string => String(a[k]);
    operate.orchestrator.registerResumer('triage', (a) =>
      code.triage.triageIssue(str(a, 'repo'), num(a, 'number'), str(a, 'userId')),
    );
    operate.orchestrator.registerResumer('pr-review', (a) =>
      code.prReviews.analyzePr(
        str(a, 'repo'),
        num(a, 'number'),
        str(a, 'userId'),
        typeof a.context === 'string' ? { context: a.context } : undefined,
      ),
    );
    operate.orchestrator.registerResumer('ci-analysis', (a) =>
      code.prReviews.analyzeFailedChecks(str(a, 'repo'), num(a, 'number'), str(a, 'userId')),
    );

  },
  /**
   * Installation tokens last an hour, so they are re-minted well before that.
   * The margin must exceed the interval: a single failed run then still leaves
   * a valid token and another attempt before anything expires.
   */
  jobs: [
    {
      id: 'code.github-app-tokens',
      everyMs: 10 * 60_000,
      run: async (ctx) => {
        const result = await ctx.services
          .get('code')
          .githubAccounts.refreshInstallationTokens(25 * 60_000, (msg) => ctx.log.warn(msg));
        if (result.refreshed) ctx.log.info(`refreshed ${result.refreshed} GitHub App installation token(s)`);
        announceCredentialHealth(ctx, result);
      },
    },
  ],
  /** A daemon down longer than an hour wakes with every app token expired. */
  postActivate: async (ctx) => {
    const result = await ctx.services
      .get('code')
      .githubAccounts.refreshInstallationTokens(25 * 60_000, (msg) => ctx.log.warn(msg));
    announceCredentialHealth(ctx, result);
  },
  onDisable: (ctx) => {
    offSetupCompleted?.();
    offSetupCompleted = null;
    // Unplug our account-aware resolver; operate then fails network Git closed.
    ctx.services.get('operate').resetGithubTokenSource();
  },
});
