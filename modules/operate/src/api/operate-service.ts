import { notFound } from '@moxxy/companion-core/server';
import type { AuthUser } from '@moxxy/companion-contracts';
import type {
  GithubTokenSource,
  QueuedRunEntry,
  RunQueueSnapshot,
  RunRecord,
  RunTaskDescriptor,
  RunUsageSnapshot,
  RunVerification,
  TokenUsage,
} from '../contract/index.js';
import { estimateUsd } from '../contract/model-pricing.js';
import type { AgentPolicy } from './agent-policy.js';
import type { Budgets } from './budgets.js';
import type { Orchestrator } from './orchestrator.js';
import type { Runners } from './runners-registry.js';
import { rowToRun, type RunsStore } from './runs-store.js';
import type { WebhookTunnel } from './webhook-tunnel.js';
import type { Skills } from './skills.js';
import type { Checkouts } from '../exec/checkouts.js';
import { PromptEvaluationCatalog } from './prompt-evaluations.js';

/**
 * The execution-plane bundle other modules resolve via
 * `ctx.services.get('operate')`: the orchestrator (launch/drive runs), the
 * runner registry (placement/health), checkouts (clones/worktrees), the public
 * webhook tunnel and the skill library. Also the
 * plug point for module-code's GitHub token resolver (inversion of control —
 * code depends on operate, never the reverse).
 */
export class OperateService {
  /** The built-in fail-closed resolver, restored when module-code disables. */
  private readonly defaultTokenSource: GithubTokenSource;

  /** Feature tasks modules registered, keyed by id — feeds the runner filter UI. */
  private readonly runTasks = new Map<string, RunTaskDescriptor>();

  /** Exact production prompt/parser seams registered by their owning modules. */
  readonly promptEvaluations = new PromptEvaluationCatalog();

  constructor(
    readonly orchestrator: Orchestrator,
    readonly runners: Runners,
    readonly checkouts: Checkouts,
    readonly webhookTunnel: WebhookTunnel,
    readonly skills: Skills,
    /** The owner's runs store — consumers read/write run rows through it, never raw SQL. */
    readonly runsStore: RunsStore,
    private readonly tokenSource: { current: GithubTokenSource },
    /** Monthly spend ceilings and cost attribution. */
    readonly budgets: Budgets,
    /** What agent work is permitted to do, as instance configuration. */
    readonly agentPolicy: AgentPolicy,
  ) {
    this.defaultTokenSource = tokenSource.current;
  }

  /**
   * Plug in where a repository's verification command comes from. Module-code
   * owns repositories and depends on operate, so it registers here at enable,
   * exactly like the git token source. Unset means nothing is verified.
   */
  setVerifyCommandResolver(resolve: (repo: string) => string | null): void {
    this.orchestrator.setVerifyCommandResolver(resolve);
  }

  /** The parsed pre-review verification for a run; operate owns the encoding. */
  verificationFor(runId: string): RunVerification | null {
    return this.runsStore.get(runId) ? rowToRun(this.runsStore.get(runId)!, false).verification : null;
  }

  /**
   * Usage evidence for an aggregate job after one of its children settles.
   * The runs table and harness declaration are both Operate-owned, as is the
   * model price table, so downstream modules get one already-normalised answer.
   */
  usageForRun(runId: string): RunUsageSnapshot | null {
    const row = this.runsStore.get(runId);
    return row ? usageSnapshot(rowToRun(row, false)) : null;
  }

  /**
   * Drop a finished run's worktree now, rather than waiting out retention.
   *
   * The time-based sweep is the backstop for everything nobody told us about; this
   * is for the case where we KNOW the work is over, which is worth having because
   * a worktree with a populated node_modules is large and a busy board would
   * otherwise hold days of them.
   *
   * Refuses on a run that may still be read. The protected set is the same one
   * storage cleanup uses, so "still in use" has one definition rather than two
   * that drift.
   */
  async releaseWorktree(runId: string): Promise<boolean> {
    const row = this.runsStore.get(runId);
    if (!row || !row.repo || !row.cwd) return false;
    if (row.status === 'provisioning' || row.status === 'running' || row.status === 'idle' || row.status === 'review') {
      return false;
    }
    // removeWorktree already tolerates a worktree that is gone, so a second
    // release (a retry, or the sweep having got there first) is a no-op.
    await this.runners.backendForRun(row.runner_id).removeWorktree(row.repo, row.cwd);
    return true;
  }

  /**
   * Declare a feature-level unit of agent work ('board.worker') so runners can
   * block it. Modules register at enable, alongside their queue resumers; the
   * matching id must be passed as `task` wherever the feature creates runs.
   */
  registerRunTask(task: RunTaskDescriptor): void {
    this.runTasks.set(task.id, task);
  }

  /** Every registered task, placeable ones first, alphabetical within a group. */
  runTaskDescriptors(): RunTaskDescriptor[] {
    return [...this.runTasks.values()].sort(
      (a, b) => Number(b.placeable) - Number(a.placeable) || a.label.localeCompare(b.label),
    );
  }

  /**
   * The single owner of run-stream visibility — the security rule that gates
   * who may see a run's record, events, turns and asks. Consumers (this
   * module's routes, module-code's fix-flow routes, the WS scope resolver) all
   * go through here so the rule has one definition:
   *  - attended chats (interactive / AI Help) are private to their owner — one
   *    maintainer must never see another's assistant;
   *  - repo runs are private to the profile whose personal GitHub account
   *    authorized them (workspace membership alone cannot reveal the clone);
   *  - other repo-less runs (automated one-shots) stay visible to runs:read.
   */
  canSeeRun(user: AuthUser | null, run: { repo: string | null; kind: string; userId: string | null }): boolean {
    if (!user) return false;
    if (run.kind === 'interactive' || run.kind === 'assistant') return run.userId === user.username;
    if (run.repo) return run.userId === user.username;
    return true;
  }

  /** Resolve a run the caller may see, or 404 (existence is hidden from those
   *  who can't see it — a leak of run ids would leak repo/membership shape). */
  requireRunAccess(user: AuthUser | null, id: string): RunRecord {
    const run = this.orchestrator.getRun(id);
    if (!run || !this.canSeeRun(user, run)) throw notFound(`run ${id} not found`);
    return run;
  }

  /** Queue rows can expose the same repo/title metadata as runs, so they use
   *  the same workspace boundary before they become persisted run records. */
  queueSnapshot(user: AuthUser | null): RunQueueSnapshot {
    const snapshot = this.orchestrator.queueSnapshot();
    const entries = snapshot.entries
      .filter((entry) => this.canSeeQueueEntry(user, entry))
      .map((entry, position) => ({ ...entry, position }));
    return { ...snapshot, entries };
  }

  canSeeQueueEntry(user: AuthUser | null, entry: Pick<QueuedRunEntry, 'repo' | 'userId'>): boolean {
    if (!user) return false;
    return entry.repo ? entry.userId === user.username : true;
  }

  /**
   * The dashboard's cost analytics — the last 14 local days of token spend,
   * as a zero-filled daily series plus per-model window totals, aggregated in
   * SQL. Visibility is canSeeRun resolved to a SQL scope up front (per-repo
   * access checked once over the window's DISTINCT repos, never per run), so
   * the aggregates leak nothing the run list hides.
   */
  tokenUsage(user: AuthUser | null): TokenUsage {
    if (!user) return { days: [], models: [] };
    const DAYS = 14;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const since = today.getTime() - (DAYS - 1) * 86_400_000;
    const scope = { username: user.username };
    const days = Array.from({ length: DAYS }, (_, i) => ({
      dayStart: since + i * 86_400_000,
      inputTokens: 0,
      outputTokens: 0,
    }));
    for (const row of this.runsStore.usageByDay(since, scope)) {
      const day = days[row.bucket];
      if (!day) continue; // clock skew put a row outside the window — drop it
      day.inputTokens = row.input;
      day.outputTokens = row.output;
    }
    const models = this.runsStore.usageByModel(since, scope).map((row) => ({
      model: row.model,
      runs: row.runs,
      inputTokens: row.input,
      outputTokens: row.output,
    }));
    return { days, models };
  }

  /** module-code plugs its account-aware resolver in at onEnable. */
  setGithubTokenSource(source: GithubTokenSource): void {
    this.tokenSource.current = source;
  }

  /** Restore the built-in fail-closed resolver when code disables. */
  resetGithubTokenSource(): void {
    this.tokenSource.current = this.defaultTokenSource;
  }

  /** The current git-credential source (default: no credential). */
  githubTokens(): GithubTokenSource {
    return this.tokenSource.current;
  }
}

/** Pure form kept exported so capability/zero-telemetry semantics are testable. */
export function usageSnapshot(
  run: Pick<RunRecord, 'model' | 'harness' | 'inputTokens' | 'outputTokens'>,
): RunUsageSnapshot {
  const reported = run.inputTokens + run.outputTokens > 0;
  return {
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    estimatedCostUsd: reported ? estimateUsd(run.model, run.inputTokens, run.outputTokens) : null,
    telemetry: reported
      ? 'reported'
      : run.harness.capabilities.usage === 'tokens'
        ? 'missing'
        : 'unsupported',
  };
}
