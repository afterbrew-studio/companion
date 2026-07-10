import type { ReposStore } from './repos-store.js';
import type { IssuesStore } from './issues-store.js';
import type { PrsStore } from './prs-store.js';
import type { GitHubAccounts } from './github-accounts.js';
import type { GitHubSync } from './github-sync.js';
import type { Triage } from './triage.js';
import type { PrReviews } from './pr-reviews.js';
import type { PrChecks } from './pr-checks.js';
import type { Fixes } from './fixes.js';
import type { Pipelines } from './pipelines.js';

/**
 * The GitHub/code-domain bundle other modules resolve via
 * `ctx.services.get('code')`: the sync cache stores (repos/issues/prs — reads
 * go through the owner, never raw SQL), the multi-account GitHub registry, and
 * the triage/review/checks/fixes/pipelines services. plan consumes repos +
 * fixes + the client resolver; automations consumes most of it.
 */
export class CodeService {
  constructor(
    readonly repos: ReposStore,
    readonly issues: IssuesStore,
    readonly prs: PrsStore,
    readonly githubAccounts: GitHubAccounts,
    readonly sync: GitHubSync,
    readonly triage: Triage,
    readonly prReviews: PrReviews,
    readonly prChecks: PrChecks,
    readonly fixes: Fixes,
    readonly pipelines: Pipelines,
  ) {}
}
