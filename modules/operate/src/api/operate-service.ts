import { notFound } from '@companion/core/server';
import type { AuthUser } from '@companion/contracts';
import type { GithubTokenSource, RunRecord } from '../contract/index.js';
import type { Orchestrator } from './orchestrator.js';
import type { Runners } from './runners-registry.js';
import type { RunsStore } from './runs-store.js';
import type { WebhookTunnel } from './webhook-tunnel.js';
import type { Skills } from './skills.js';
import type { Checkouts } from '../exec/checkouts.js';
import type { MoxxyCli } from '../exec/cli.js';

/**
 * The execution-plane bundle other modules resolve via
 * `ctx.services.get('operate')`: the orchestrator (launch/drive runs), the
 * runner registry (placement/health), checkouts (clones/worktrees), the
 * detected moxxy CLI, the public webhook tunnel and the skill library. Also the
 * plug point for module-code's GitHub token resolver (inversion of control —
 * code depends on operate, never the reverse).
 */
export class OperateService {
  /** The built-in settings-key resolver, restored when module-code disables. */
  private readonly defaultTokenSource: GithubTokenSource;

  constructor(
    readonly orchestrator: Orchestrator,
    readonly runners: Runners,
    readonly checkouts: Checkouts,
    readonly moxxyCli: MoxxyCli | null,
    readonly webhookTunnel: WebhookTunnel,
    readonly skills: Skills,
    /** The owner's runs store — consumers read/write run rows through it, never raw SQL. */
    readonly runsStore: RunsStore,
    private readonly tokenSource: { current: GithubTokenSource },
    /** Workspace repo-access check, resolved lazily so the current workspace
     *  instance is always used. operate dependsOn workspace, so it's present. */
    private readonly canAccessRepo: (user: AuthUser, repo: string) => boolean,
  ) {
    this.defaultTokenSource = tokenSource.current;
  }

  /**
   * The single owner of run-stream visibility — the security rule that gates
   * who may see a run's record, events, turns and asks. Consumers (this
   * module's routes, module-code's fix-flow routes, the WS scope resolver) all
   * go through here so the rule has one definition:
   *  - admins see everything;
   *  - attended chats (interactive / AI Help) are private to their owner — one
   *    maintainer must never see another's assistant;
   *  - repo runs inherit that repo's workspace access;
   *  - other repo-less runs (automated one-shots) stay visible to runs:read.
   */
  canSeeRun(user: AuthUser | null, run: { repo: string | null; kind: string; userId: string | null }): boolean {
    if (!user) return false;
    if (user.role === 'admin') return true;
    if (run.kind === 'interactive' || run.kind === 'assistant') return run.userId === user.username;
    if (run.repo) return this.canAccessRepo(user, run.repo);
    return true;
  }

  /** Resolve a run the caller may see, or 404 (existence is hidden from those
   *  who can't see it — a leak of run ids would leak repo/membership shape). */
  requireRunAccess(user: AuthUser | null, id: string): RunRecord {
    const run = this.orchestrator.getRun(id);
    if (!run || !this.canSeeRun(user, run)) throw notFound(`run ${id} not found`);
    return run;
  }

  /** module-code plugs its account-aware resolver in at onEnable. */
  setGithubTokenSource(source: GithubTokenSource): void {
    this.tokenSource.current = source;
  }

  /** module-code restores the built-in resolver at onDisable, so a disabled (or
   *  uninstalled) code module's account registry stops governing git credentials. */
  resetGithubTokenSource(): void {
    this.tokenSource.current = this.defaultTokenSource;
  }

  /** The current git-credential source (default: the legacy settings key). */
  githubTokens(): GithubTokenSource {
    return this.tokenSource.current;
  }
}
