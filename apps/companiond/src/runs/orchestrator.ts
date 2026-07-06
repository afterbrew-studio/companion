import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AskRequest,
  NotificationKind,
  HistorySegment,
  ModelCatalog,
  ModelCatalogModel,
  ModelCatalogProvider,
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
            this.setStatus(runId, 'review');
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
          this.notifyRun(runId, 'action_required', 'Agent needs your input');
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
            this.setStatus(runId, 'stopped');
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
    model?: string | null;
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
      model: opts.model ?? this.pinnedModel(opts.kind ?? 'interactive'),
      createdAt: now,
      updatedAt: now,
      inputTokens: 0,
      outputTokens: 0,
      outcome: null,
    });
    this.broadcast({ t: 'runs.changed' });

    try {
      await this.pool.spawn({ runId: id, cwd, moxxyCliPath: this.moxxyCliPath });
      this.setStatus(id, 'running');
    } catch (err) {
      this.setStatus(id, 'failed', String(err));
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
      try {
        await this.pool.spawn({ runId, cwd: row.cwd, moxxyCliPath: this.moxxyCliPath });
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
    const handle = this.pool.get(runId);
    if (handle) await handle.stop();
    const row = this.store.getRun(runId);
    if (row && row.status === 'running') this.setStatus(runId, 'stopped');
    this.emitRunChanged(runId);
  }

  /**
   * Single choke point for status changes: persists the transition and drops
   * an inbox notification for the ones a human acts on.
   */
  private setStatus(runId: string, status: RunRecord['status'], outcome?: string | null): void {
    const prev = this.store.getRun(runId)?.status;
    this.store.updateRunStatus(runId, status, outcome);
    if (prev === status) return;
    if (status === 'review') this.notifyRun(runId, 'action_required', 'Run ready for review');
    else if (status === 'completed') this.notifyRun(runId, 'finished', 'Run completed');
    else if (status === 'failed') this.notifyRun(runId, 'error', 'Run failed', outcome ?? undefined);
  }

  private notifyRun(runId: string, kind: NotificationKind, title: string, body?: string): void {
    const run = this.store.getRun(runId);
    if (!run) return;
    const workspaceId = run.repo ? (this.store.getRepo(run.repo)?.workspace_id ?? null) : null;
    this.store.insertNotification({
      id: `ntf-${randomUUID().slice(0, 12)}`,
      workspaceId,
      kind,
      title,
      body: body ?? run.title,
      href: `#/runs/${runId}`,
      createdAt: Date.now(),
    });
    this.broadcast({ t: 'notifications.changed' });
  }

  markRun(runId: string, status: RunRecord['status'], outcome?: string): void {
    this.setStatus(runId, status, outcome ?? null);
    this.emitRunChanged(runId);
  }

  // ---------- interaction -----------------------------------------------------------

  async sendPrompt(runId: string, prompt: string, model?: string): Promise<{ turnId: string }> {
    const handle = this.requireLive(runId);
    // Per-turn pin > the run's persisted override > the daemon default.
    let chosen = model ?? this.store.getRun(runId)?.model ?? this.config.defaultModel;
    // Disabled selections quietly ride the daemon default instead of erroring.
    if (chosen !== this.config.defaultModel && this.disabledModels().has(chosen)) {
      chosen = this.config.defaultModel;
    }
    const result = await handle.client.runTurn({ prompt, model: chosen });
    // The gateway never broadcasts turn.started — synthesize it.
    this.broadcast({ t: 'turn', runId, phase: 'started', turnId: result.turnId });
    return result;
  }

  async setGoalMode(runId: string): Promise<void> {
    await this.requireLive(runId).client.setMode('goal');
  }

  // ---------- model switching -----------------------------------------------------

  /**
   * Admin-pinned model for an action kind (settings `modelPin:<kind>`); new
   * runs of that kind ride the pin unless the caller overrides explicitly.
   * A pin pointing at a disabled model falls back to the daemon default.
   */
  private pinnedModel(kind: RunKind): string | null {
    const pinned = this.store.getSetting(`modelPin:${kind}`);
    if (!pinned || pinned.trim() === '') return null;
    return this.disabledModels().has(pinned) ? null : pinned;
  }

  /** Admin-disabled model ids (settings `disabledModels`, JSON array). */
  private disabledModels(): Set<string> {
    try {
      const raw = this.store.getSetting('disabledModels');
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  }

  /** Admin-disabled provider names (settings `disabledProviders`, JSON array). */
  private disabledProviders(): Set<string> {
    try {
      const raw = this.store.getSetting('disabledProviders');
      return new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set();
    }
  }

  /** Connected providers + models, read live from the run's gateway. */
  async modelCatalog(runId: string): Promise<ModelCatalog> {
    const disabledProviders = this.disabledProviders();
    const disabledModels = this.disabledModels();
    const handle = this.requireLive(runId);
    const info = (await handle.client.sessionInfo()) as {
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
          enabled: p.enabled !== false && !disabledProviders.has(p.name),
          ready: ready.has(p.name),
          models: models.filter((m) => !disabledModels.has(m.id) && !disabledModels.has(`${p.name}/${m.id}`)),
        };
      })
      .filter((p): p is ModelCatalogProvider => p !== null);
    // Cache the provider/model catalog so settings pages can offer dropdowns
    // even when no gateway is live anymore.
    try {
      this.store.setSetting('modelCatalogCache', JSON.stringify({ providers }));
    } catch {
      // cache is best-effort
    }
    return {
      activeProvider: typeof info?.activeProvider === 'string' ? info.activeProvider : null,
      providers,
      current: this.store.getRun(runId)?.model ?? this.config.defaultModel,
      defaultModel: this.config.defaultModel,
    };
  }

  /**
   * Daemon-wide catalog for settings pages: read fresh from any live gateway,
   * else the cached copy from the last live one — and when neither exists,
   * probe: spawn a temporary gateway just to ask moxxy for the catalog, cache
   * it, and reap the process. Users never need to know model ids by heart.
   */
  async sharedModelCatalog(): Promise<{
    providers: ModelCatalogProvider[];
    defaultModel: string;
    fresh: boolean;
  }> {
    const liveId = this.pool.liveIds()[0];
    if (liveId) {
      try {
        const catalog = await this.modelCatalog(liveId);
        return { providers: [...catalog.providers], defaultModel: this.config.defaultModel, fresh: true };
      } catch {
        // fall through to the cache
      }
    }
    let cached = this.readCatalogCache();
    if (!cached) {
      await this.probeCatalog();
      cached = this.readCatalogCache();
    }
    return { providers: cached ?? [], defaultModel: this.config.defaultModel, fresh: false };
  }

  private readCatalogCache(): ModelCatalogProvider[] | null {
    try {
      const raw = this.store.getSetting('modelCatalogCache');
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { providers?: ModelCatalogProvider[] };
      return parsed.providers ?? null;
    } catch {
      return null;
    }
  }

  /** Single-flight, cooldown-guarded temporary-gateway catalog probe. */
  private catalogProbe: Promise<void> | null = null;
  private lastCatalogProbeAt = 0;

  private probeCatalog(): Promise<void> {
    if (this.catalogProbe) return this.catalogProbe;
    if (Date.now() - this.lastCatalogProbeAt < 60_000) return Promise.resolve();
    this.lastCatalogProbeAt = Date.now();
    const job = (async () => {
      const probeId = `catalog-probe-${randomUUID().slice(0, 8)}`;
      const cwd = paths.scratch();
      mkdirSync(cwd, { recursive: true });
      try {
        await this.pool.spawn({ runId: probeId, cwd, moxxyCliPath: this.moxxyCliPath });
        await this.modelCatalog(probeId); // success path writes the cache
        log.info('model catalog probed via temporary gateway');
      } catch (err) {
        log.warn('model catalog probe failed', { err: String(err) });
      } finally {
        await this.pool
          .get(probeId)
          ?.stop()
          .catch(() => undefined);
      }
    })();
    this.catalogProbe = job.finally(() => {
      this.catalogProbe = null;
    });
    return this.catalogProbe;
  }

  /**
   * On-the-fly model switch. The persisted override is authoritative (it rides
   * every runTurn); syncing the live session is best-effort because the
   * headless serve runner doesn't handle session.setModel/setProvider — there
   * the slash-command path (/provider, /model) is the supported fallback.
   */
  async setRunModel(runId: string, model: string | null, provider?: string): Promise<RunRecord> {
    if (!this.store.getRun(runId)) throw new Error(`unknown run: ${runId}`);
    const handle = this.pool.get(runId);
    if (handle?.client.isOpen) {
      if (provider) {
        await handle.client
          .setProvider(provider)
          .catch(() => handle.client.runCommand('provider', provider))
          .catch((err) => log.warn('provider switch failed', { runId, provider, err: String(err) }));
      }
      await handle.client
        .setModel(model)
        .catch(() => (model ? handle.client.runCommand('model', model) : undefined))
        .catch((err) => log.warn('session model sync failed', { runId, err: String(err) }));
    }
    this.store.setRunModel(runId, model);
    this.emitRunChanged(runId);
    return this.getRun(runId)!;
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
        if (finalMessage === null) {
          // Aborted stream, dead gateway, or timeout — never report success.
          const status = this.store.getRun(run.id)?.status;
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
        this.setStatus(runId, row.status, 'aborted: output token ceiling exceeded');
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
        this.setStatus(runId, this.store.getRun(runId)?.status ?? 'running', `${subtype}: ${summary}`);
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
