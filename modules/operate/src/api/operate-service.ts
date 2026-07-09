import type { GithubTokenSource } from '../contract/index.js';
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
  ) {}

  /** module-code plugs its account-aware resolver in at onEnable. */
  setGithubTokenSource(source: GithubTokenSource): void {
    this.tokenSource.current = source;
  }

  /** The current git-credential source (default: the legacy settings key). */
  githubTokens(): GithubTokenSource {
    return this.tokenSource.current;
  }
}
