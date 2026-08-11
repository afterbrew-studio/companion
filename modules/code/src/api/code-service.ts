import type { ReposStore } from './repos-store.js';
import type { IssuesStore } from './issues-store.js';
import type { PrsStore } from './prs-store.js';
import type { GitHubAccounts } from './github-accounts.js';
import type { GitHubSync } from './github-sync.js';
import type { Triage } from './triage.js';
import type { PrReviews } from './pr-reviews.js';
import type { ReviewChat } from './review-chat.js';
import type { PrChecks } from './pr-checks.js';
import type { Fixes } from './fixes.js';
import type { Pipelines } from './pipelines.js';
import type { RepoAgentContextScanner } from './repo-agent-context.js';
import type { RepoPermission } from '../contract/index.js';
import { mapConcurrent } from './concurrency.js';

/**
 * The GitHub/code-domain bundle other modules resolve via
 * `ctx.services.get('code')`: the sync cache stores (repos/issues/prs — reads
 * go through the owner, never raw SQL), the multi-account GitHub registry, and
 * the triage/review/checks/fixes/pipelines services. plan consumes repos +
 * fixes + the client resolver; automations consumes most of it.
 */
export class CodeService {
  private localGhImport: Promise<boolean> | null = null;

  constructor(
    readonly repos: ReposStore,
    readonly issues: IssuesStore,
    readonly prs: PrsStore,
    readonly githubAccounts: GitHubAccounts,
    readonly sync: GitHubSync,
    readonly triage: Triage,
    readonly prReviews: PrReviews,
    readonly reviewChat: ReviewChat,
    readonly prChecks: PrChecks,
    readonly agentContext: RepoAgentContextScanner,
    readonly fixes: Fixes,
    readonly pipelines: Pipelines,
    private readonly importActiveLocalGh: () => Promise<boolean>,
  ) {}

  /** Coalesce boot/setup triggers so the same host credential is never raced
   * through two GitHub validation requests. A later trigger may retry a
   * transient failure. */
  importLocalGhAccount(): Promise<boolean> {
    if (this.localGhImport) return this.localGhImport;
    this.localGhImport = this.importActiveLocalGh().finally(() => {
      this.localGhImport = null;
    });
    return this.localGhImport;
  }

  /**
   * The best permission this profile's own accounts hold across one workspace.
   * This is the shared read boundary for Code's HTTP feeds and cross-module
   * compositions: workspace membership alone must never expose cached GitHub
   * rows after a personal credential loses access.
   */
  async repoPermissions(username: string, workspaceId: string): Promise<Map<string, RepoPermission>> {
    const rows = this.repos.listByWorkspace(workspaceId);
    const graded = await mapConcurrent(rows, 8, async (row) => {
      const permission = await this.githubAccounts.permissionFor('fetch', row.full_name, {
        username,
        workspaceId,
      });
      return permission ? ([row.full_name, permission] as const) : null;
    });
    return new Map(graded.filter((entry): entry is readonly [string, RepoPermission] => entry !== null));
  }

  /** Repositories whose cached GitHub rows this profile may currently read. */
  async accessibleRepoNames(username: string, workspaceId: string): Promise<string[]> {
    return [...(await this.repoPermissions(username, workspaceId)).keys()];
  }
}
