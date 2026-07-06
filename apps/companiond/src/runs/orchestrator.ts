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

/**
 * Run lifecycle owner. A "run" is one moxxy session (one MOXXY_SESSION_ID);
 * live runs have a gateway process attached, reaped runs keep their transcript
 * readable from the session JSONL on disk.
 */
export class Orchestrator {
  private readonly pool: GatewayPool;
  /** Pending asks per run, so the SPA can re-fetch after a reload. */
  private readonly pendingAsks = new Map<string, Map<string, AskRequest>>();

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
        },
        onAsk: (runId, ask) => {
          this.asksFor(runId).set(ask.requestId, ask);
          this.broadcast({ t: 'ask', runId, ask });
        },
        onAskResolved: (runId, requestId) => {
          this.asksFor(runId).delete(requestId);
          this.broadcast({ t: 'askResolved', runId, requestId });
        },
        onGone: (runId) => {
          this.pendingAsks.delete(runId);
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

  async createRun(opts: { kind?: RunKind; title?: string; cwd?: string }): Promise<RunRecord> {
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
      repo: null,
      issueNumber: null,
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
      await this.pool.spawn({ runId, cwd: row.cwd, moxxyCliPath: this.moxxyCliPath });
    }
    this.store.updateRunStatus(runId, 'running');
    this.emitRunChanged(runId);
    return this.getRun(runId)!;
  }

  async stopRun(runId: string): Promise<void> {
    const handle = this.pool.get(runId);
    if (handle) await handle.stop();
    this.store.updateRunStatus(runId, 'stopped');
    this.emitRunChanged(runId);
  }

  // ---------- interaction -----------------------------------------------------------

  async sendPrompt(runId: string, prompt: string, model?: string): Promise<{ turnId: string }> {
    const handle = this.requireLive(runId);
    const result = await handle.client.runTurn({ prompt, model });
    // The standalone gateway never broadcasts turn.started — synthesize it.
    this.broadcast({ t: 'turn', runId, phase: 'started', turnId: result.turnId });
    return result;
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

  // ---------- internals -----------------------------------------------------------

  private onEvent(runId: string, event: MoxxyEvent): void {
    if (event.type === 'provider_response') {
      const input = numberField(event, 'inputTokens');
      const output = numberField(event, 'outputTokens');
      if (input || output) this.store.addRunUsage(runId, input, output);
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
