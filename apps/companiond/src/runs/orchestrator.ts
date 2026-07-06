import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AskRequest,
  HistorySegment,
  MoxxyEvent,
  RunKind,
  RunRecord,
  SpaServerMessage,
} from '@companion/contract';
import { log } from '../log.js';
import { paths, type DaemonConfig } from '../config.js';
import { GatewayPool } from '../moxxy/gateway-pool.js';
import { readSessionHistory } from '../moxxy/history.js';
import { Store, rowToRun } from '../store/db.js';

/** Hard per-run output-token ceiling (goal mode upstream is uncapped). */
const MAX_RUN_OUTPUT_TOKENS = 400_000;

/**
 * Run lifecycle owner. A "run" is one moxxy session (one MOXXY_SESSION_ID);
 * live runs have a serve+gateway process pair attached, reaped runs keep their
 * transcript readable from the session JSONL on disk.
 */
export class Orchestrator {
  private readonly pool: GatewayPool;
  private readonly pendingAsks = new Map<string, Map<string, AskRequest>>();
  /** waitForTurn resolvers, keyed by runId. */
  private readonly turnWaiters = new Map<string, Set<() => void>>();
  /** Sequential queue for unattended runs so batches respect the pool cap. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: Store,
    private readonly config: DaemonConfig,
    private readonly moxxyCliPath: string,
    private readonly broadcast: (msg: SpaServerMessage) => void,
  ) {
    this.pool = new GatewayPool(
      {
        onEvent: (runId, event) => this.onEvent(runId, event),
        onTurnComplete: (runId, turnId) => {
          this.broadcast({ t: 'turn', runId, phase: 'complete', turnId });
          const waiters = this.turnWaiters.get(runId);
          if (waiters) {
            for (const resolve of [...waiters]) resolve();
            waiters.clear();
          }
          // Autonomous goal runs land in review when their driving turn ends.
          const row = this.store.getRun(runId);
          if (row && (row.kind === 'fix' || row.kind === 'implement') && row.status === 'running') {
            this.store.updateRunStatus(runId, 'review');
            this.emitRunChanged(runId);
          }
        },
        onAsk: (runId, ask) => {
          // Unattended runs must never park on a human. Tools without a
          // declared allow-policy (e.g. Glob on moxxy 0.26.0) reach the ask
          // path; auto-allow them — the real fences are the isolated
          // clone/worktree cwd and the permissions.json deny rules.
          const row = this.store.getRun(runId);
          if (row && row.kind !== 'interactive' && ask.kind === 'permission') {
            log.info('auto-allowing ask for unattended run', {
              runId,
              tool: ask.tool?.name,
            });
            void this.respondAsk(runId, ask.requestId, { mode: 'allow' }).catch(() => undefined);
            return;
          }
          this.asksFor(runId).set(ask.requestId, ask);
          this.broadcast({ t: 'ask', runId, ask });
        },
        onAskResolved: (runId, requestId) => {
          this.asksFor(runId).delete(requestId);
          this.broadcast({ t: 'askResolved', runId, requestId });
        },
        onGone: (runId) => {
          this.pendingAsks.delete(runId);
          const waiters = this.turnWaiters.get(runId);
          if (waiters) {
            for (const resolve of [...waiters]) resolve();
            waiters.clear();
          }
          const row = this.store.getRun(runId);
          if (row && (row.status === 'running' || row.status === 'provisioning')) {
            this.store.updateRunStatus(runId, 'stopped');
          }
          this.emitRunChanged(runId);
        },
      },
      config.maxLiveRuns,
    );
  }

  /** Boot-time recovery: daemon died with children; rows are the truth. */
  recover(): void {
    const swept = this.store.markInterruptedRuns();
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

  async shutdown(): Promise<void> {
    await this.pool.stopAll();
  }

  // ---------- queries -----------------------------------------------------------

  listRuns(): RunRecord[] {
    return this.store.listRuns().map((row) => rowToRun(row, this.pool.get(row.id) !== undefined));
  }

  getRun(runId: string): RunRecord | null {
    const row = this.store.getRun(runId);
    return row ? rowToRun(row, this.pool.get(runId) !== undefined) : null;
  }

  pendingAsksFor(runId: string): AskRequest[] {
    return [...this.asksFor(runId).values()];
  }

  // ---------- lifecycle -----------------------------------------------------------

  async createRun(opts: {
    kind?: RunKind;
    title?: string;
    cwd?: string;
    repo?: string | null;
    issueNumber?: number | null;
    proposalId?: string | null;
    branch?: string | null;
  }): Promise<RunRecord> {
    const id = `run-${randomUUID().slice(0, 12)}`;
    const now = Date.now();
    const kind: RunKind = opts.kind ?? 'interactive';
    // Each run gets its own cwd so concurrent agents never share a directory.
    const cwd = opts.cwd ?? join(paths.scratch(), id);
    mkdirSync(cwd, { recursive: true });
    this.store.insertRun({
      id,
      kind,
      status: 'provisioning',
      title: opts.title ?? 'New run',
      cwd,
      repo: opts.repo ?? null,
      issueNumber: opts.issueNumber ?? null,
      proposalId: opts.proposalId ?? null,
      branch: opts.branch ?? null,
      prUrl: null,
      createdAt: now,
      updatedAt: now,
      inputTokens: 0,
      outputTokens: 0,
      outcome: null,
    });
    this.broadcast({ t: 'runs.changed' });

    try {
      await this.pool.spawn({ runId: id, cwd, moxxyCliPath: this.moxxyCliPath });
      this.store.updateRunStatus(id, 'running');
    } catch (err) {
      this.store.updateRunStatus(id, 'failed', String(err));
      this.emitRunChanged(id);
      throw err;
    }
    this.emitRunChanged(id);
    return this.getRun(id)!;
  }

  /** Re-attach a gateway to an existing (reaped/interrupted) run's session. */
  async resumeRun(runId: string): Promise<RunRecord> {
    const row = this.store.getRun(runId);
    if (!row) throw new Error(`unknown run: ${runId}`);
    if (!this.pool.get(runId)) {
      mkdirSync(row.cwd, { recursive: true });
      await this.pool.spawn({ runId, cwd: row.cwd, moxxyCliPath: this.moxxyCliPath });
    }
    this.store.updateRunStatus(runId, 'running');
    this.emitRunChanged(runId);
    return this.getRun(runId)!;
  }

  async stopRun(runId: string): Promise<void> {
    const handle = this.pool.get(runId);
    if (handle) await handle.stop();
    const row = this.store.getRun(runId);
    if (row && row.status === 'running') this.store.updateRunStatus(runId, 'stopped');
    this.emitRunChanged(runId);
  }

  markRun(runId: string, status: RunRecord['status'], outcome?: string): void {
    this.store.updateRunStatus(runId, status, outcome ?? null);
    this.emitRunChanged(runId);
  }

  // ---------- interaction -----------------------------------------------------------

  async sendPrompt(runId: string, prompt: string, model?: string): Promise<{ turnId: string }> {
    const handle = this.requireLive(runId);
    const result = await handle.client.runTurn({ prompt, model });
    // The gateway never broadcasts turn.started — synthesize it.
    this.broadcast({ t: 'turn', runId, phase: 'started', turnId: result.turnId });
    return result;
  }

  async setGoalMode(runId: string): Promise<void> {
    await this.requireLive(runId).client.setMode('goal');
  }

  async abortTurn(runId: string, turnId?: string): Promise<void> {
    await this.requireLive(runId).client.abortTurn(turnId);
  }

  async respondAsk(
    runId: string,
    requestId: string,
    response: { mode?: 'allow' | 'allow_session' | 'allow_always' | 'deny'; optionId?: string; text?: string },
  ): Promise<void> {
    await this.requireLive(runId).client.respondAsk(requestId, response);
    this.asksFor(runId).delete(requestId);
  }

  async loadHistory(runId: string, before: number | null, limit: number): Promise<HistorySegment> {
    const handle = this.pool.get(runId);
    if (handle?.client.isOpen) return handle.client.loadHistory(runId, before, limit);
    return readSessionHistory(runId, before, limit);
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
    cwd: string;
    repo?: string | null;
    issueNumber?: number | null;
    prompt: string;
    timeoutMs?: number;
  }): Promise<{ runId: string; finalMessage: string | null }> {
    const job = async (): Promise<{ runId: string; finalMessage: string | null }> => {
      const run = await this.createRun(opts);
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
        this.store.updateRunStatus(run.id, 'completed');
        return { runId: run.id, finalMessage };
      } catch (err) {
        this.store.updateRunStatus(run.id, 'failed', String(err));
        throw err;
      } finally {
        await this.stopRun(run.id).catch(() => undefined);
      }
    };
    const result = this.queue.then(job, job);
    this.queue = result.catch(() => undefined);
    return result;
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

  private onEvent(runId: string, event: MoxxyEvent): void {
    if (event.type === 'provider_response') {
      const input = numberField(event, 'inputTokens');
      const output = numberField(event, 'outputTokens');
      if (input || output) this.store.addRunUsage(runId, input, output);
      // moxxy's goal mode is uncapped (its built-in budgets were removed in
      // #439) — companiond's ceiling is the PRIMARY runaway-cost guard.
      const row = this.store.getRun(runId);
      if (row && row.output_tokens > MAX_RUN_OUTPUT_TOKENS && row.status === 'running') {
        log.warn('run exceeded token ceiling — aborting', { runId, outputTokens: row.output_tokens });
        this.store.updateRunStatus(runId, row.status, 'aborted: output token ceiling exceeded');
        void this.abortTurn(runId).catch(() => undefined);
      }
    }
    if (event.type === 'plugin_event') {
      const subtype = (event as { subtype?: string }).subtype ?? '';
      if (subtype === 'goal_completed' || subtype === 'goal_abandoned' || subtype === 'goal_stalled') {
        const payload = (event as { payload?: unknown }).payload;
        const summary =
          typeof payload === 'object' && payload !== null
            ? ((payload as { summary?: string; reason?: string }).summary ??
              (payload as { summary?: string; reason?: string }).reason ??
              subtype)
            : subtype;
        this.store.updateRunStatus(runId, this.store.getRun(runId)?.status ?? 'running', `${subtype}: ${summary}`);
      }
    }
    this.broadcast({ t: 'event', runId, event });
  }

  private requireLive(runId: string) {
    const handle = this.pool.get(runId);
    if (!handle || !handle.client.isOpen) {
      throw new Error(`run ${runId} has no live gateway (resume it first)`);
    }
    return handle;
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
