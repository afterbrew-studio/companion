import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AskRequest, HistorySegment, MoxxyEvent, PromptAttachment } from '@moxxy/companion-types';
import type { ModuleConfigAccessor } from '@moxxy/companion-core';
import type { SpaServerMessage } from '@moxxy/companion-contracts';
import type {
  GitCredentialResolver,
  ModelCatalog,
  ModelCatalogModel,
  ModelCatalogProvider,
  RunKind,
  RunnerFallback,
  RunQueueSnapshot,
  RunRecord,
} from '../contract/index.js';
import { log, paths, type DaemonConfig } from '@moxxy/companion-services';
import { describeHarness, MOXXY_HARNESS } from './harnesses.js';
import { rowToRun } from './runs-store.js';
import { LOCAL_RUNNER_ID } from './runners-store.js';
import type { Checkouts } from '../exec/checkouts.js';
import type { MoxxyCli } from '../exec/cli.js';
import { Runners } from './runners-registry.js';
import type { RunnerBackend, RunnerEventSink } from './backend.js';
import type { OperateStore } from './operate-store.js';
import { AgentPolicy } from './agent-policy.js';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** A queued unattended job: display metadata plus its start/cancel handles. */
interface QueueItem {
  id: string;
  kind: RunKind;
  title: string;
  repo: string | null;
  issueNumber: number | null;
  userId: string | null;
  priority: number;
  enqueuedAt: number;
  /** How to replay this entry after a restart; absent = not persisted. */
  resume?: { type: string; args: Record<string, unknown> };
  /** Acquire a slot and run the job (resolves/rejects the caller's promise). */
  start: () => void;
  /** Reject the caller's promise; used when cancelled before it starts. */
  cancel: () => void;
}

/**
 * Default scheduling weight per kind — higher jumps ahead in the queue. Code
 * changes a human is waiting on (fix/implement) outrank review/triage, which
 * outrank background reports; interactive chats sit lowest so they never delay
 * automated work. Users can still reorder manually.
 */
const KIND_PRIORITY: Record<RunKind, number> = {
  fix: 70,
  implement: 70,
  triage: 50,
  analysis: 50,
  report: 30,
  interactive: 10,
  assistant: 10,
};

/** Settings key holding a task's instance-wide model pin. */
function taskPinKey(task: string): string {
  return `modelPin:task:${task}`;
}

/**
 * Is the queue stuck rather than merely busy?
 *
 * The distinction is the whole point. Work waiting while other work runs is the
 * scheduler doing its job and must never alert. Work waiting while NOTHING runs
 * means no eligible machine is taking it, and it will keep waiting until an
 * operator changes something.
 */
export function isQueueStalled(state: {
  oldestEnqueuedAt: number | null;
  activeRuns: number;
  stallMs: number;
  now: number;
}): boolean {
  if (state.oldestEnqueuedAt === null) return false;
  if (state.activeRuns > 0) return false;
  return state.now - state.oldestEnqueuedAt >= state.stallMs;
}

/** Stable identity for a resume descriptor (key order independent). */
function resumeKeyOf(resume: { type: string; args: Record<string, unknown> }): string {
  const parts = Object.keys(resume.args)
    .sort()
    .map((k) => `${k}=${String(resume.args[k])}`);
  return `${resume.type}:${parts.join('&')}`;
}

/**
 * Run lifecycle owner. A "run" is one moxxy session (one MOXXY_SESSION_ID)
 * executing on some runner (machine). Live runs have a serve+gateway pair
 * attached on their runner; reaped runs keep their transcript readable from
 * the session JSONL on that runner's disk. The Orchestrator never talks to a
 * gateway directly — it goes through the run's RunnerBackend, so local and
 * remote execution are indistinguishable to everything above it.
 */
export class Orchestrator implements RunnerEventSink {
  readonly runners: Runners;
  private readonly pendingAsks = new Map<string, Map<string, AskRequest>>();
  /** waitForTurn resolvers, keyed by runId. */
  private readonly turnWaiters = new Map<string, Set<() => void>>();
  // Unattended runs schedule against the runners' combined capacity (shared +
  // dedicated): up to that many run at once, the rest wait in a visible queue
  // the user can reorder and cancel.
  private oneShotActive = 0;
  private readonly oneShotQueue: QueueItem[] = [];
  /** Per-kind replayers used to re-dispatch persisted queue entries on boot. */
  private readonly resumers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  /**
   * On boot, the persisted (priority, enqueuedAt) for each entry being resumed,
   * keyed by resume type+args. The re-dispatched item adopts these so the queue
   * order — including manual reordering — is reproduced exactly after a restart.
   */
  private pendingResume = new Map<string, { priority: number; enqueuedAt: number }>();
  /** Whether the queue-stall alert is currently raised, so it fires on transition. */
  private queueStalled = false;

  constructor(
    private readonly store: OperateStore,
    private readonly config: DaemonConfig,
    checkouts: Checkouts,
    moxxyCli: MoxxyCli | null,
    private readonly broadcast: (msg: SpaServerMessage) => void,
    private readonly githubTokenFor: GitCredentialResolver = () => null,
    private readonly moduleConfig: ModuleConfigAccessor = { values: () => ({}), get: () => null },
    /** Roles are stored by module-core; the daemon plugs its reader in here. */
    roleOf?: (username: string) => string | null,
    /**
     * Spend ceiling. Throws to refuse a run; a no-op when no budget is
     * configured, which is the default. Structural so the orchestrator does not
     * own the pricing question, and so tests can drive the gate directly.
     */
    private readonly budgetGate: (userId: string | null) => void = () => {},
    /**
     * Operator-facing health alerts (runner offline, queue not draining). A
     * no-op by default so the orchestrator stays constructible in tests without
     * a notification sink; services.ts wires it to ctx.notify.
     */
    private readonly health: (
      kind: 'error' | 'info' | 'action_required',
      title: string,
      body: string,
    ) => void = () => {},
    /** What agent work may do. Defaults read the built-in values, so an
     *  orchestrator constructed without one behaves exactly as before. */
    private readonly agentPolicy: AgentPolicy = new AgentPolicy({ values: () => ({}), get: () => null }),
  ) {
    this.runners = new Runners(
      store,
      checkouts,
      moxxyCli,
      config.maxLiveRuns,
      this,
      broadcast,
      githubTokenFor,
      () => ({
        worktreeRetentionMs: this.retentionMs('worktreeRetentionDays', 3, DAY_MS),
        scratchRetentionMs: this.retentionMs('scratchRetentionHours', 24, HOUR_MS),
        sessionRetentionMs: this.retentionMs('sessionRetentionDays', 30, DAY_MS),
      }),
      {
        roleOf,
        fallback: () => this.unplacedWork(),
        assertPushTarget: (repo, branch) => this.agentPolicy.assertPushTarget(repo, branch),
      },
    );
  }

  /** Where work no machine's policy accepts goes (module config, read live). */
  private unplacedWork(): RunnerFallback {
    const value = this.moduleConfig.get('unplacedWork');
    return value === 'local' || value === 'refuse' ? value : 'policy';
  }

  /** The backend a run executes on (its runner, or local). */
  private backend(runId: string): RunnerBackend {
    return this.runners.backendForRun(this.store.runs.get(runId)?.runner_id ?? null);
  }

  // ---------- RunnerEventSink (fed by every backend, local or remote) ----------

  onTurnComplete(runId: string, turnId?: string): void {
    this.broadcast({ t: 'turn', runId, phase: 'complete', turnId });
    const waiters = this.turnWaiters.get(runId);
    if (waiters) {
      for (const resolve of [...waiters]) resolve();
      waiters.clear();
    }
    // Autonomous goal runs land in review when their driving turn ends;
    // attended chats (interactive / AI Help) go idle — the gateway stays live
    // but nothing is in flight, so they must not read as "running".
    const row = this.store.runs.get(runId);
    if (row && (row.kind === 'fix' || row.kind === 'implement') && row.status === 'running') {
      this.setStatus(runId, 'review');
      this.emitRunChanged(runId);
    } else if (row && (row.kind === 'interactive' || row.kind === 'assistant') && row.status === 'running') {
      this.setStatus(runId, 'idle');
      this.emitRunChanged(runId);
    }
  }

  onAsk(runId: string, ask: AskRequest): void {
    // Unattended runs must never park on a human. Tools without a declared
    // allow-policy (e.g. Glob on moxxy 0.26.0) reach the ask path; auto-allow
    // them — the real fences are the isolated clone/worktree cwd and the
    // permissions.json deny rules. Attended kinds (interactive chats, the AI
    // Help assistant) keep the human in the loop: their asks park in the UI.
    const row = this.store.runs.get(runId);
    const attended = row?.kind === 'interactive' || row?.kind === 'assistant';
    if (row && !attended && ask.kind === 'permission') {
      log.info('auto-allowing ask for unattended run', { runId, tool: ask.tool?.name });
      void this.respondAsk(runId, ask.requestId, { mode: 'allow' }).catch(() => undefined);
      return;
    }
    this.asksFor(runId).set(ask.requestId, ask);
    this.broadcast({ t: 'ask', runId, ask });
  }

  onAskResolved(runId: string, requestId: string): void {
    this.asksFor(runId).delete(requestId);
    this.broadcast({ t: 'askResolved', runId, requestId });
  }

  onGone(runId: string): void {
    this.pendingAsks.delete(runId);
    const waiters = this.turnWaiters.get(runId);
    if (waiters) {
      for (const resolve of [...waiters]) resolve();
      waiters.clear();
    }
    const row = this.store.runs.get(runId);
    if (row && (row.status === 'running' || row.status === 'provisioning' || row.status === 'idle')) {
      this.setStatus(runId, 'stopped');
    }
    this.emitRunChanged(runId);
  }

  /**
   * A runner went unreachable: its provisioning/running/idle runs are stranded
   * (their gateway, session, and worktree live on that machine). Mark them
   * interrupted with a telling outcome — the transcript stays readable once the
   * machine returns, and owners watching run.changed (the board's retry, one-shot
   * waiters) treat interrupted as terminal failure and redispatch elsewhere.
   */
  onRunnerUnreachable(runnerId: string, detail: string): void {
    for (const row of this.store.runs.activeOnRunner(runnerId)) {
      log.warn('run stranded by unreachable runner', { runId: row.id, runner: runnerId });
      this.pendingAsks.delete(row.id);
      const waiters = this.turnWaiters.get(row.id);
      if (waiters) {
        for (const resolve of [...waiters]) resolve();
        waiters.clear();
      }
      this.setStatus(row.id, 'interrupted', `runner unreachable: ${detail}`);
      this.emitRunChanged(row.id);
    }
    const name = this.store.runners.get(runnerId)?.name ?? runnerId;
    this.health(
      'error',
      `Runner '${name}' went offline`,
      `${detail}. Runs placed there were marked interrupted; new work is placed on the remaining machines, ` +
        'or queued if none is eligible.',
    );
  }

  onRunnerReachable(runnerId: string): void {
    const name = this.store.runners.get(runnerId)?.name ?? runnerId;
    this.health('info', `Runner '${name}' is back online`, 'It is eligible for placement again.');
  }

  /**
   * The queue is not draining. Distinct from "the queue is busy", which is the
   * system working: work waiting with NOTHING running means no eligible machine
   * is taking it, and it will keep waiting until someone acts. Announced once
   * per stall so a long outage does not post on every tick.
   */
  checkQueueStall(stallMs: number): void {
    const oldest = this.oneShotQueue.reduce<number | null>(
      (acc, q) => (acc === null || q.enqueuedAt < acc ? q.enqueuedAt : acc),
      null,
    );
    const stalled = isQueueStalled({
      oldestEnqueuedAt: oldest,
      activeRuns: this.oneShotActive + this.store.runs.activeNonQueueCount(),
      stallMs,
      now: Date.now(),
    });
    if (stalled === this.queueStalled) return;
    this.queueStalled = stalled;
    if (stalled) {
      this.health(
        'action_required',
        `${this.oneShotQueue.length} queued run(s) are not starting`,
        `Nothing has been running for ${Math.round((Date.now() - oldest!) / 60_000)} minutes while work waits. ` +
          'Check that a runner is online and that its task policy accepts this work.',
      );
    } else {
      this.health('info', 'The run queue is draining again', 'Queued work has started executing.');
    }
  }

  /** Boot-time recovery: daemon died with children; rows are the truth. */
  recover(): void {
    const swept = this.store.runs.markInterrupted();
    if (swept > 0) log.info(`marked ${swept} run(s) interrupted from previous daemon life`);
    // Children die with the daemon, so every socket file left behind is stale.
    try {
      for (const name of readdirSync(paths.sockets())) {
        rmSync(join(paths.sockets(), name), { force: true });
      }
    } catch {
      // sweep is best-effort
    }
  }

  start(): void {
    this.runners.start();
  }

  async shutdown(): Promise<void> {
    this.runners.stop();
    await this.runners.localBackend.stopAll();
  }

  // ---------- queries -----------------------------------------------------------

  private isLive(runId: string): boolean {
    return this.backend(runId).isLive(runId);
  }

  listRuns(): RunRecord[] {
    return this.store.runs.list().map((row) => rowToRun(row, this.isLive(row.id)));
  }

  getRun(runId: string): RunRecord | null {
    const row = this.store.runs.get(runId);
    return row ? rowToRun(row, this.isLive(runId)) : null;
  }

  pendingAsksFor(runId: string): AskRequest[] {
    return [...this.asksFor(runId).values()];
  }

  // ---------- lifecycle -----------------------------------------------------------

  /**
   * Provider-aware placement: resolve the model the run will actually ride
   * (explicit > standing preference > task pin > daemon default) to the
   * providers that serve it, and prefer a runner advertising one of them.
   * Callers that provision a worktree before createRun (fixes, pipelines) use
   * this so the worktree lands on the runner the run will execute on.
   *
   * Throws when no machine's policy accepts the task and the instance's
   * fallback refuses — better here, before a worktree exists, than after.
   */
  placeRun(
    repo: string | null,
    opts: {
      model?: string | null;
      /** A standing preference (see createRun); steers placement, never fails it. */
      preferredModel?: string | null;
      userId?: string | null;
      /** Runner ids to skip — failover after a spawn just failed there. */
      exclude?: ReadonlySet<string>;
      /** Feature-level task id ('board.worker'): runners can block it, and it
       *  carries the instance model pin. */
      task?: string | null;
    } = {},
  ): string | null {
    const effective =
      opts.model ??
      this.servableAnywhere(opts.preferredModel ?? null) ??
      this.pinnedModel(opts.task ?? null) ??
      this.config.defaultModel;
    return this.runners.place(repo, opts.task ?? null, effective, opts.userId ?? null, opts.exclude);
  }

  async createRun(opts: {
    kind?: RunKind;
    title?: string;
    /** Prepared working dir (a worktree on the run's runner). When set,
     *  `runnerId` MUST identify the runner that owns it. */
    cwd?: string;
    /** Runner the run executes on; undefined = place by repo. */
    runnerId?: string | null;
    repo?: string | null;
    issueNumber?: number | null;
    proposalId?: string | null;
    branch?: string | null;
    model?: string | null;
    /**
     * A model chosen ahead of time for the unit of work this run serves (a
     * board card), sitting between an explicit choice and the task pin. Soft
     * like a pin, and for the same reason: it is chosen once and reused by
     * every run that unit spawns, days later, on whichever machine is free,
     * so a machine that cannot serve it falls through the cascade rather than
     * failing the run after its branch and worktree exist.
     */
    preferredModel?: string | null;
    /** Triggering user: owns attended runs and unlocks their personal runners
     *  for placement; null for automation (shared runners only). */
    userId?: string | null;
    /** Feature-level task id (RunTaskDescriptor) — always server-assigned by
     *  the owning feature, never client input, so filters can't be dodged. */
    task?: string | null;
  }): Promise<RunRecord> {
    // Before every other check and before any side effect: a run refused for
    // budget must leave no row, no worktree and no queue entry behind.
    this.budgetGate(opts.userId ?? null);
    if (opts.repo) {
      if (!opts.userId) {
        throw new Error(`a personal GitHub account owner is required to run agents for ${opts.repo}`);
      }
      if (!(await this.githubTokenFor(opts.repo, opts.userId))) {
        throw new Error(
          `your GitHub accounts cannot access ${opts.repo} — ask the repository owner to grant access`,
        );
      }
    }
    // Refuse a model no machine may run rather than start the run on something
    // else: output from a model the caller did not choose is the worse answer.
    // Only a provable gap refuses (some catalog lists it, no machine allows it).
    if (opts.model && this.runners.runnersForModel(opts.model)?.size === 0) {
      throw new Error(
        `no runner may use ${opts.model}: enable it on a machine under Providers, or choose another model`,
      );
    }
    const id = `run-${randomUUID().slice(0, 12)}`;
    const now = Date.now();
    const kind: RunKind = opts.kind ?? 'interactive';
    // Reserve slots for automated work: attended chats (interactive / AI Help)
    // may not consume the last `reservedRunnerSlots` of the combined capacity,
    // so triage/review/fix always have room. Always leaves at least one chat
    // slot even on a single-runner install.
    if (kind === 'interactive' || kind === 'assistant') {
      // The user's personal runners extend THEIR chat capacity — a colleague's
      // busy shared slots must not block someone whose own machine is idle.
      // Task-filtered: a runner that blocks chats adds no chat slots — and its
      // slots already serve automation, so they satisfy the reserve first and
      // only the remainder is carved out of the chat pool.
      const total = Math.max(1, this.runners.totalCapacity(opts.userId ?? null));
      const capacity = Math.max(1, this.runners.totalCapacity(opts.userId ?? null, opts.task ?? null));
      const reserved = Math.min(capacity - 1, Math.max(0, this.reservedRunnerSlots() - (total - capacity)));
      const pool = this.runners.runnersAllowing(opts.task ?? null);
      if (this.store.runs.activeInteractiveCount(opts.userId ?? null, pool) >= capacity - reserved) {
        throw new Error(
          `All runner slots are busy and ${reserved} ${reserved === 1 ? 'is' : 'are'} reserved for automated work — close a chat or try again shortly.`,
        );
      }
    }
    // Placement: an explicit runnerId wins; a caller-prepared cwd (a local
    // worktree/clone from a one-shot) pins to the local runner; otherwise pick
    // a ready runner for the repo and let its backend allocate a scratch dir.
    const runnerId =
      opts.runnerId !== undefined
        ? opts.runnerId
        : opts.cwd !== undefined
          ? null
          : this.placeRun(opts.repo ?? null, {
              model: opts.model,
              preferredModel: opts.preferredModel,
              userId: opts.userId,
              task: opts.task,
            });
    // Model: explicit override → the unit of work's standing preference → the
    // task's instance pin, the last two applied only where the machine can
    // serve them. null falls through to the daemon default at dispatch, and to
    // the runner's own moxxy default when even that cannot be served there.
    const model =
      opts.model ??
      this.servableHere(runnerId, opts.preferredModel ?? null) ??
      this.servablePin(runnerId, opts.task ?? null);
    const backend = this.runners.backend(runnerId);
    // Reserve the slot atomically: persist the provisioning row (carrying
    // runner_id) BEFORE the first await, so a concurrent createRun's placement
    // counts this run and spreads instead of overshooting one runner's cap.
    // The scratch dir is allocated after; setPlacement backfills the real cwd.
    this.store.runs.insert({
      id,
      kind,
      status: 'provisioning',
      title: opts.title ?? 'New run',
      cwd: opts.cwd ?? '',
      repo: opts.repo ?? null,
      issueNumber: opts.issueNumber ?? null,
      proposalId: opts.proposalId ?? null,
      branch: opts.branch ?? null,
      prUrl: null,
      model,
      runnerId,
      userId: opts.userId ?? null,
      task: opts.task ?? null,
      harness: this.runners.harnessFor(runnerId).id,
      createdAt: now,
      updatedAt: now,
      inputTokens: 0,
      outputTokens: 0,
      outcome: null,
    });
    this.broadcast({ t: 'runs.changed' });

    // Auto-placed runs fail over: a scratch/spawn failure marks the runner for
    // a health recheck and retries on the next-best placement. Explicitly
    // pinned runs (caller-prepared cwd or runnerId) can't move — their working
    // dir exists only on that machine.
    const autoPlaced = opts.runnerId === undefined && opts.cwd === undefined;
    const tried = new Set<string>([runnerId ?? LOCAL_RUNNER_ID]);
    let placedOn = runnerId;
    let placedBackend = backend;
    let cwd = opts.cwd;
    for (;;) {
      try {
        if (opts.cwd === undefined) {
          cwd = await placedBackend.scratchDir(id);
          this.store.runs.setPlacement(id, placedOn, cwd, this.runners.harnessFor(placedOn).id);
        }
        await placedBackend.spawn(id, cwd!);
        this.setStatus(id, 'running');
        // The gateway is up anyway — top up that machine's catalog for free if
        // it has gone stale (never blocks the run).
        this.runners.noteLiveSession(placedOn, id);
        break;
      } catch (err) {
        this.runners.recheckHealth(placedOn);
        // A refusal here means the remaining machines' policies won't take the
        // run: there is nowhere to fail over TO, and the spawn failure that got
        // us here is the error worth reporting.
        let next: string | null | undefined;
        try {
          next = autoPlaced
            ? this.placeRun(opts.repo ?? null, {
                model: opts.model,
                preferredModel: opts.preferredModel,
                userId: opts.userId,
                exclude: tried,
                task: opts.task,
              })
            : undefined;
        } catch {
          next = undefined;
        }
        if (next === undefined || tried.has(next ?? LOCAL_RUNNER_ID)) {
          this.setStatus(id, 'failed', String(err));
          this.emitRunChanged(id);
          throw err;
        }
        log.warn('run placement failed over', { runId: id, from: placedOn, to: next, err: String(err) });
        tried.add(next ?? LOCAL_RUNNER_ID);
        placedOn = next;
        placedBackend = this.runners.backend(placedOn);
        // The machine changed, so re-resolve: the new one may not serve the
        // preference or the pin.
        this.store.runs.setModel(
          id,
          opts.model ??
            this.servableHere(placedOn, opts.preferredModel ?? null) ??
            this.servablePin(placedOn, opts.task ?? null),
        );
      }
    }
    this.emitRunChanged(id);
    return this.getRun(id)!;
  }

  /** Drop a file into a run's working dir on whatever runner it executes on. */
  async writeRunFile(runId: string, relPath: string, content: string): Promise<void> {
    const run = this.store.runs.get(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    await this.runners.backendForRun(run.runner_id ?? null).writeFile(run.cwd, relPath, content);
  }

  /** Re-attach a gateway to an existing (reaped/interrupted) run's session. */
  async resumeRun(runId: string): Promise<RunRecord> {
    const row = this.store.runs.get(runId);
    if (!row) throw new Error(`unknown run: ${runId}`);
    if (!this.isLive(runId)) {
      try {
        await this.backend(runId).spawn(runId, row.cwd);
      } catch (err) {
        log.warn('resume failed', { runId, err: String(err) });
        throw new Error(`could not resume: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // A fix/implement run awaiting human review keeps its review status —
    // resuming just re-attaches the transcript/chat, it doesn't "un-review".
    if (row.status !== 'review') this.setStatus(runId, 'running');
    this.emitRunChanged(runId);
    return this.getRun(runId)!;
  }

  async stopRun(runId: string): Promise<void> {
    await this.backend(runId).stop(runId);
    const row = this.store.runs.get(runId);
    if (row && (row.status === 'running' || row.status === 'idle')) this.setStatus(runId, 'stopped');
    this.emitRunChanged(runId);
  }

  /** Run lifecycle is audit state, not a user action; owning features notify on their outcomes. */
  private setStatus(runId: string, status: RunRecord['status'], outcome?: string | null): void {
    this.store.runs.updateStatus(runId, status, outcome);
  }

  markRun(runId: string, status: RunRecord['status'], outcome?: string): void {
    this.setStatus(runId, status, outcome ?? null);
    this.emitRunChanged(runId);
  }

  // ---------- interaction -----------------------------------------------------------

  async sendPrompt(runId: string, prompt: string, model?: string, attachments?: readonly PromptAttachment[]): Promise<{ turnId: string }> {
    const backend = this.requireLive(runId);
    const row = this.store.runs.get(runId);
    // A new turn on an idle attended chat: it's working again.
    if (row?.status === 'idle') {
      this.setStatus(runId, 'running');
      this.emitRunChanged(runId);
    }
    const runnerId = row?.runner_id ?? null;
    // Per-turn pin > the run's persisted override. Refuse rather than
    // substitute: answering with a model the user did not choose is the worst
    // outcome here, so a machine that provably cannot run the chosen model
    // fails the turn with something the user can act on. Selection already
    // hides these (the pickers only offer what the machine serves); this is the
    // guard for the window where policy changed after they chose.
    const requested = model ?? row?.model ?? null;
    if (requested !== null && !this.runners.serves(runnerId, requested)) {
      throw new Error(
        `${requested} is not enabled on the machine this run is on. Enable it there under Providers, or switch this run to another model`,
      );
    }
    // Nobody chose a model: the daemon default is itself a fallback, so when
    // this machine cannot serve it the machine's own default applies. That is
    // an absent choice, not a substituted one.
    const chosen =
      requested ?? (this.runners.serves(runnerId, this.config.defaultModel) ? this.config.defaultModel : null);
    const result = await backend.runTurn(runId, { prompt, model: chosen ?? undefined, attachments });
    // The gateway never broadcasts turn.started — synthesize it.
    this.broadcast({ t: 'turn', runId, phase: 'started', turnId: result.turnId });
    return result;
  }

  /**
   * Put an autonomous run into goal mode. A harness whose permission and
   * behaviour are settled when its process starts has no mode to set halfway
   * through, and asking anyway would fail the run: the check is the capability
   * it declares, not a try/catch that would also swallow a real failure.
   */
  async setGoalMode(runId: string): Promise<void> {
    const run = this.store.runs.get(runId);
    if (!describeHarness(run?.harness ?? MOXXY_HARNESS.id).capabilities.sessionControls.mode) return;
    await this.requireLive(runId).setMode(runId, 'goal');
  }

  // ---------- model switching -----------------------------------------------------

  /**
   * The instance pin for a task, exactly as stored (null = unpinned). The
   * settings page reads this; dispatch goes through `pinnedModel`, which drops
   * a pin no machine may serve.
   */
  taskModelPin(task: string): string | null {
    const pinned = this.store.settings.get(taskPinKey(task));
    return pinned && pinned.trim() !== '' ? pinned : null;
  }

  /** Bind a task to a model instance-wide; null (or blank) clears the pin. */
  setTaskModelPin(task: string, model: string | null): void {
    this.store.settings.set(taskPinKey(task), model?.trim() ?? '');
  }

  /**
   * A standing model preference (a task pin, a board card's model), dropped
   * where no machine may run it: such a preference falls back to the rest of
   * the cascade rather than failing every run it covers, because it is a
   * preference and not a choice a user just made.
   */
  private servableAnywhere(model: string | null): string | null {
    if (model === null) return null;
    // `runnersForModel` answers null for a model nobody serves, not an empty
    // set, so testing the size alone lets exactly that case through.
    const servers = this.runners.runnersForModel(model);
    return servers && servers.size > 0 ? model : null;
  }

  /**
   * The same preference, narrowed to the machine the run actually landed on.
   * Placement prefers a machine that serves it but is free to choose another
   * (the pool's own machines block tasks, go offline and fill up), and binding
   * a run to a model its machine cannot serve would fail the run's every turn.
   * Same reasoning as `servableAnywhere`, one step later.
   */
  private servableHere(runnerId: string | null, model: string | null): string | null {
    const preference = this.servableAnywhere(model);
    return preference !== null && this.runners.serves(runnerId, preference) ? preference : null;
  }

  /**
   * Pinned model for a unit of work (settings `modelPin:task:<id>`); new runs of
   * that task ride the pin unless the caller overrides explicitly. An unlabeled
   * run (no task) has nothing to pin against.
   */
  private pinnedModel(task: string | null): string | null {
    return task === null ? null : this.servableAnywhere(this.taskModelPin(task));
  }

  private servablePin(runnerId: string | null, task: string | null): string | null {
    return this.servableHere(runnerId, this.pinnedModel(task));
  }

  /** Connected providers + models, read live from the run's gateway. */
  async modelCatalog(runId: string): Promise<ModelCatalog> {
    // Filtered by THIS run's machine: what its neighbour allows is irrelevant
    // to a run that can only execute here.
    const policy = this.runners.policyFor(this.store.runs.get(runId)?.runner_id ?? null);
    const info = (await this.requireLive(runId).sessionInfo(runId)) as {
      activeProvider?: unknown;
      providers?: unknown;
      readyProviders?: unknown;
    } | null;
    const ready = new Set(
      Array.isArray(info?.readyProviders) ? info.readyProviders.filter((p) => typeof p === 'string') : [],
    );
    const providers: ModelCatalogProvider[] = (Array.isArray(info?.providers) ? info.providers : [])
      .map((raw): ModelCatalogProvider | null => {
        const p = raw as { name?: unknown; models?: unknown; enabled?: unknown };
        if (typeof p.name !== 'string') return null;
        const models: ModelCatalogModel[] = (Array.isArray(p.models) ? p.models : [])
          .map((m): ModelCatalogModel | null => {
            // Providers advertise models as ids or objects; tolerate both.
            if (typeof m === 'string') return { id: m, contextWindow: null };
            const obj = m as { id?: unknown; contextWindow?: unknown };
            if (typeof obj.id !== 'string') return null;
            return {
              id: obj.id,
              contextWindow: typeof obj.contextWindow === 'number' ? obj.contextWindow : null,
            };
          })
          .filter((m): m is ModelCatalogModel => m !== null);
        return {
          name: p.name,
          enabled: p.enabled !== false && !policy.providers.has(p.name),
          ready: ready.has(p.name),
          models: models.filter((m) => !policy.models.has(m.id) && !policy.models.has(`${p.name}/${m.id}`)),
        };
      })
      .filter((p): p is ModelCatalogProvider => p !== null);
    // A live gateway is the cheapest catalog there is — hand what we just read
    // to the registry (the single owner) so the settings view stays current.
    this.runners.noteSessionInfo(this.store.runs.get(runId)?.runner_id ?? null, info);
    return {
      activeProvider: typeof info?.activeProvider === 'string' ? info.activeProvider : null,
      providers,
      current: this.store.runs.get(runId)?.model ?? this.config.defaultModel,
      defaultModel: this.config.defaultModel,
    };
  }

  /**
   * On-the-fly model switch. The persisted override is authoritative (it rides
   * every runTurn); syncing the live session is best-effort because the
   * headless serve runner doesn't handle session.setModel/setProvider — there
   * the slash-command path (/provider, /model) is the supported fallback.
   */
  async setRunModel(runId: string, model: string | null, provider?: string): Promise<RunRecord> {
    const row = this.store.runs.get(runId);
    if (!row) throw new Error(`unknown run: ${runId}`);
    // Refuse the selection here rather than let the next turn fail: this run
    // can only execute on the machine it is placed on.
    if (model !== null && !this.runners.serves(row.runner_id ?? null, model)) {
      throw new Error(`${model} is not enabled on the machine this run is on. Pick a model it can serve`);
    }
    // A harness configured entirely by the flags it started with cannot be
    // re-pointed live; the persisted override still rides its next session.
    const controls = describeHarness(row.harness).capabilities.sessionControls;
    if (this.isLive(runId) && controls.model) {
      const backend = this.backend(runId);
      if (provider && controls.provider) {
        await backend
          .setProvider(runId, provider)
          .catch(() => backend.runCommand(runId, 'provider', provider))
          .catch((err) => log.warn('provider switch failed', { runId, provider, err: String(err) }));
      }
      await backend
        .setModel(runId, model)
        .catch(() => (model ? backend.runCommand(runId, 'model', model) : undefined))
        .catch((err) => log.warn('session model sync failed', { runId, err: String(err) }));
    }
    this.store.runs.setModel(runId, model);
    this.emitRunChanged(runId);
    return this.getRun(runId)!;
  }

  async abortTurn(runId: string, turnId?: string): Promise<void> {
    await this.requireLive(runId).abortTurn(runId, turnId);
  }

  async respondAsk(
    runId: string,
    requestId: string,
    response: { mode?: 'allow' | 'allow_session' | 'allow_always' | 'deny'; optionId?: string; text?: string },
  ): Promise<void> {
    await this.requireLive(runId).respondAsk(runId, requestId, response);
    this.asksFor(runId).delete(requestId);
  }

  async loadHistory(runId: string, before: number | null, limit: number): Promise<HistorySegment> {
    return this.backend(runId).loadHistory(runId, before, limit);
  }

  // ---------- autonomous runs ---------------------------------------------------------

  /** Resolves when the run's current turn completes (or its gateway dies). */
  waitForTurn(runId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      let waiters = this.turnWaiters.get(runId);
      if (!waiters) {
        waiters = new Set();
        this.turnWaiters.set(runId, waiters);
      }
      const done = (): void => {
        clearTimeout(timer);
        waiters!.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      waiters.add(done);
    });
  }

  /**
   * One bounded unattended turn: create run → prompt → await completion →
   * return the final assistant message → reap. Queued so batch jobs respect
   * the pool cap instead of exploding it.
   */
  runOneShot(opts: {
    kind: RunKind;
    title: string;
    /** Prepared repository checkout. Omit for a clean scratch run that must
     * not inspect or repeatedly tokenize repository contents. */
    cwd?: string;
    repo?: string | null;
    /** Profile whose personal GitHub account authorizes access to `repo`. */
    userId?: string | null;
    issueNumber?: number | null;
    /** Feature-level task id — carried for when one-shots learn to place. */
    task?: string;
    prompt: string;
    timeoutMs?: number;
    /**
     * Makes the queued entry survive a restart: on boot the named resumer is
     * re-invoked with these args (it rebuilds the prompt and re-enqueues). Omit
     * for work that can't be replayed from args alone (e.g. pipeline steps).
     */
    resume?: { type: string; args: Record<string, unknown> };
    /** Called as soon as the unattended job has a cancellable queue identity. */
    onQueued?: (queueId: string) => void;
    /** Called after the queue item becomes a concrete run. */
    onStarted?: (runId: string) => void;
  }): Promise<{ runId: string; finalMessage: string | null }> {
    const job = async (): Promise<{ runId: string; finalMessage: string | null }> => {
      const run = await this.createRun(opts);
      try {
        opts.onStarted?.(run.id);
      } catch (err) {
        log.warn('one-shot onStarted callback failed', { runId: run.id, err: String(err) });
      }
      try {
        const wait = this.waitForTurn(run.id, opts.timeoutMs ?? 10 * 60_000);
        await this.sendPrompt(run.id, opts.prompt);
        await wait;
        // turn.complete can race the session log's async flush — retry briefly
        // until the final assistant message is readable.
        let finalMessage: string | null = null;
        for (let attempt = 0; attempt < 8 && finalMessage === null; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 750));
          finalMessage = await this.finalAssistantMessage(run.id);
        }
        if (finalMessage === null) {
          // Aborted stream, dead gateway, or timeout — never report success.
          const status = this.store.runs.get(run.id)?.status;
          this.setStatus(
            run.id,
            'failed',
            status === 'stopped' || status === 'interrupted'
              ? 'gateway died before the turn finished (daemon restart?)'
              : 'turn ended without a final assistant message',
          );
        } else {
          this.setStatus(run.id, 'completed');
        }
        return { runId: run.id, finalMessage };
      } catch (err) {
        this.setStatus(run.id, 'failed', String(err));
        throw err;
      } finally {
        await this.stopRun(run.id).catch(() => undefined);
      }
    };
    return this.scheduleOneShot(
      {
        kind: opts.kind,
        title: opts.title,
        repo: opts.repo ?? null,
        issueNumber: opts.issueNumber ?? null,
        userId: opts.userId ?? null,
        resume: opts.resume,
        onQueued: opts.onQueued,
      },
      job,
    );
  }

  // ---------- run queue -------------------------------------------------------

  /**
   * Enqueue an unattended job. It starts immediately if the combined runner
   * capacity has a free slot; otherwise it waits in a visible queue (reorderable
   * and cancellable) and starts when a slot frees. Replaces the old serial
   * queue — batches now fan out across the whole pool.
   */
  private scheduleOneShot<T>(
    meta: {
      kind: RunKind;
      title: string;
      repo: string | null;
      issueNumber: number | null;
      userId: string | null;
      resume?: { type: string; args: Record<string, unknown> };
      onQueued?: (queueId: string) => void;
    },
    job: () => Promise<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // A resumed entry adopts its persisted weight + enqueue time so the queue
      // order (priority + any manual reordering) is reproduced across restarts,
      // regardless of the order resumers happen to re-enqueue in.
      const resumeKey = meta.resume ? resumeKeyOf(meta.resume) : null;
      const restored = resumeKey ? this.pendingResume.get(resumeKey) : undefined;
      if (resumeKey && restored) this.pendingResume.delete(resumeKey);
      const priority = restored?.priority ?? KIND_PRIORITY[meta.kind] ?? 40;
      const item: QueueItem = {
        id: `q-${randomUUID().slice(0, 12)}`,
        kind: meta.kind,
        title: meta.title,
        repo: meta.repo,
        issueNumber: meta.issueNumber,
        userId: meta.userId,
        priority,
        enqueuedAt: restored?.enqueuedAt ?? Date.now(),
        resume: meta.resume,
        start: () => {
          this.oneShotActive++;
          void job()
            .then(resolve, reject)
            .finally(() => {
              this.oneShotActive--;
              this.pumpQueue();
            });
        },
        cancel: () => reject(new Error('run cancelled before it started')),
      };
      this.oneShotQueue.push(item);
      try {
        meta.onQueued?.(item.id);
      } catch (err) {
        log.warn('one-shot onQueued callback failed', { queueId: item.id, err: String(err) });
      }
      this.sortQueue();
      this.pumpQueue();
      this.broadcastQueue();
    });
  }

  /** Order the waiting queue: higher weight first, then earliest enqueued. */
  private sortQueue(): void {
    this.oneShotQueue.sort((a, b) => b.priority - a.priority || a.enqueuedAt - b.enqueuedAt);
  }

  /**
   * Start as many queued jobs as free capacity allows. Occupancy is this
   * scheduler's in-flight jobs PLUS runs that bypass the queue (attended chats,
   * fix/implement started directly) — otherwise the queue would overcommit the
   * pool whenever chats are already holding slots.
   */
  private pumpQueue(): void {
    let started = false;
    const capacity = Math.max(1, this.runners.totalCapacity());
    const nonQueue = this.store.runs.activeNonQueueCount();
    while (this.oneShotQueue.length > 0 && this.oneShotActive + nonQueue < capacity) {
      this.oneShotQueue.shift()!.start();
      started = true;
    }
    if (started) this.broadcastQueue();
  }

  private broadcastQueue(): void {
    this.persistQueue();
    this.broadcast({ t: 'queue.changed' });
  }

  /** Mirror the waiting queue (replayable entries only) to the DB for restart. */
  private persistQueue(): void {
    try {
      this.store.runQueue.replaceAll(
        this.oneShotQueue
          .filter((q) => q.resume)
          .map((q) => ({
            id: q.id,
            kind: q.kind,
            title: q.title,
            repo: q.repo,
            issueNumber: q.issueNumber,
            priority: q.priority,
            resumeType: q.resume!.type,
            resumeArgs: q.resume!.args,
            enqueuedAt: q.enqueuedAt,
          })),
      );
    } catch (err) {
      log.warn('failed to persist run queue', { err: String(err) });
    }
  }

  /**
   * Register how a persisted queue entry of `type` is re-dispatched. Registering
   * also replays any matching work still waiting in the durable queue, so a
   * module enabled AFTER operate (e.g. module-code re-enabled at runtime) picks
   * up its own persisted entries instead of leaving them stranded.
   */
  registerResumer(type: string, fn: (args: Record<string, unknown>) => Promise<unknown>): void {
    this.resumers.set(type, fn);
    this.replayResumable();
  }

  /**
   * Re-dispatch work that was still waiting when the daemon last stopped. Reads
   * the persisted queue and re-invokes each entry's resumer (which rebuilds the
   * prompt and re-enqueues fresh). Entries whose resumer isn't registered YET are
   * KEPT in the durable queue — their owning module isn't enabled — and replay
   * when it registers (never silently dropped). Call after services are wired.
   */
  resumePersistedQueue(): void {
    const total = this.store.runQueue.list().length;
    if (total === 0) return;
    log.info(`resuming persisted run queue (${total} entr${total === 1 ? 'y' : 'ies'})`);
    this.replayResumable();
    const remaining = this.store.runQueue.list().length;
    if (remaining > 0) log.info(`${remaining} queued run(s) await a not-yet-enabled module's resumer`);
  }

  /** Re-dispatch every queued entry whose resumer is registered; keep the rest persisted. */
  private replayResumable(): void {
    const entries = this.store.runQueue.list();
    const resumable = entries.filter((e) => this.resumers.has(e.resumeType));
    if (resumable.length === 0) return;
    // Keep unresumable entries in their persisted order; only the resumable ones
    // leave the durable queue as they re-dispatch.
    this.store.runQueue.replaceAll(entries.filter((e) => !this.resumers.has(e.resumeType)));
    for (const e of resumable) {
      // Remember each entry's persisted order so the re-dispatched item reclaims
      // its exact place, no matter what order the async resumers re-enqueue in.
      this.pendingResume.set(resumeKeyOf({ type: e.resumeType, args: e.resumeArgs }), {
        priority: e.priority,
        enqueuedAt: e.enqueuedAt,
      });
      void this.resumers.get(e.resumeType)!(e.resumeArgs).catch((err) =>
        log.warn(`failed to resume queued ${e.resumeType}`, { title: e.title, err: String(err) }),
      );
    }
  }

  /** Slots kept free from attended chats for automated work (module config, live). */
  private reservedRunnerSlots(): number {
    const v = this.moduleConfig.get('reservedRunnerSlots');
    return typeof v === 'number' ? v : 1;
  }

  /** Module-config values are validated by the kernel; keep a fail-safe here
   * for old/corrupt rows so cleanup never turns an invalid value into zero. */
  private retentionMs(key: string, fallback: number, unitMs: number): number {
    const value = this.moduleConfig.get(key);
    return (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback) * unitMs;
  }

  /** The scheduler's live state for the UI: running count, capacity, and the line. */
  queueSnapshot(): RunQueueSnapshot {
    return {
      active: this.oneShotActive + this.store.runs.activeNonQueueCount(),
      capacity: Math.max(1, this.runners.totalCapacity()),
      entries: this.oneShotQueue.map((q, i) => ({
        id: q.id,
        position: i,
        kind: q.kind,
        title: q.title,
        repo: q.repo,
        issueNumber: q.issueNumber,
        userId: q.userId,
        priority: q.priority,
        enqueuedAt: q.enqueuedAt,
      })),
    };
  }

  /**
   * Move a waiting entry one step up or down. Swaps the two items' sort keys
   * (priority + enqueuedAt) rather than just their array slots, so the manual
   * order is encoded in persisted fields and survives a restart.
   */
  moveQueued(id: string, direction: 'up' | 'down'): boolean {
    const i = this.oneShotQueue.findIndex((q) => q.id === id);
    if (i < 0) return false;
    const j = direction === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= this.oneShotQueue.length) return false;
    const a = this.oneShotQueue[i]!;
    const b = this.oneShotQueue[j]!;
    [a.priority, b.priority] = [b.priority, a.priority];
    [a.enqueuedAt, b.enqueuedAt] = [b.enqueuedAt, a.enqueuedAt];
    this.sortQueue();
    this.broadcastQueue();
    return true;
  }

  /** Drop a waiting entry before it starts; its caller sees a cancellation. */
  cancelQueued(id: string): boolean {
    const i = this.oneShotQueue.findIndex((q) => q.id === id);
    if (i < 0) return false;
    const [item] = this.oneShotQueue.splice(i, 1);
    item!.cancel();
    this.broadcastQueue();
    return true;
  }

  async finalAssistantMessage(runId: string): Promise<string | null> {
    const segment = await this.loadHistory(runId, null, 300);
    for (let i = segment.events.length - 1; i >= 0; i--) {
      const event = segment.events[i];
      if (event?.type === 'assistant_message') {
        const content = (event as { content?: string }).content;
        if (typeof content === 'string' && content.trim()) return content;
      }
    }
    return null;
  }

  // ---------- internals -----------------------------------------------------------

  onEvent(runId: string, event: MoxxyEvent): void {
    if (event.type === 'provider_response') {
      const input = numberField(event, 'inputTokens');
      const output = numberField(event, 'outputTokens');
      if (input || output) this.store.runs.addUsage(runId, input, output);
      // moxxy's goal mode is uncapped (its built-in budgets were removed in
      // #439) — companiond's ceiling is the PRIMARY runaway-cost guard.
      const row = this.store.runs.get(runId);
      if (row && row.output_tokens > this.agentPolicy.maxOutputTokens() && row.status === 'running') {
        log.warn('run exceeded token ceiling — aborting', { runId, outputTokens: row.output_tokens });
        this.setStatus(runId, row.status, 'aborted: output token ceiling exceeded');
        void this.abortTurn(runId).catch(() => undefined);
      }
    }
    if (event.type === 'plugin_event') {
      const subtype = (event as { subtype?: string }).subtype ?? '';
      if (subtype === 'goal_completed' || subtype === 'goal_abandoned' || subtype === 'goal_stalled') {
        const payload = (event as { payload?: unknown }).payload;
        const info =
          typeof payload === 'object' && payload !== null ? (payload as { summary?: string; reason?: string }) : {};
        // Store just the human summary. The run STATUS already conveys
        // completed vs abandoned, so the "goal_completed:" prefix is noise —
        // and it was leaking into PR bodies/commit summaries.
        const summary = (info.summary ?? info.reason ?? '').trim();
        this.setStatus(runId, this.store.runs.get(runId)?.status ?? 'running', summary || null);
      }
    }
    if (event.type === 'error') {
      // A fatal provider/gateway error IS the run's outcome. Without recording
      // it, the turn just ends and downstream consumers (the board's no-diff
      // check) misread a dead run as "ran and changed nothing".
      const { kind, message } = event as { kind?: string; message?: string };
      if (kind === 'fatal' && message?.trim()) {
        this.setStatus(
          runId,
          this.store.runs.get(runId)?.status ?? 'running',
          `fatal: ${message.trim().slice(0, 400)}`,
        );
      }
    }
    this.broadcast({ t: 'event', runId, event });
  }

  /** The run's backend, asserting a live gateway is attached. */
  private requireLive(runId: string): RunnerBackend {
    const backend = this.backend(runId);
    if (!backend.isLive(runId)) {
      throw new Error(`run ${runId} has no live gateway (resume it first)`);
    }
    return backend;
  }

  private asksFor(runId: string): Map<string, AskRequest> {
    let map = this.pendingAsks.get(runId);
    if (!map) {
      map = new Map();
      this.pendingAsks.set(runId, map);
    }
    return map;
  }

  private emitRunChanged(runId: string): void {
    const run = this.getRun(runId);
    if (run) this.broadcast({ t: 'run.changed', run });
  }
}

function numberField(event: MoxxyEvent, key: string): number {
  const value = (event as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
