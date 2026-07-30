import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  AgentStorageCleanupRequest,
  AgentVerifyResponse,
  AgentStorageCleanupResponse,
  AskResponse,
  Harness,
  HarnessEvent,
  HarnessSessionControls,
  HistorySegment,
  ProvisionProviderSpec,
  RunTurnArgs,
  RunTurnResult,
} from '@moxxy/companion-types';
import { paths } from '@moxxy/companion-services';
import type { RunnerHealth } from '../contract/index.js';
import { ClaudeCodeHarness, readClaudeRunHistory } from '../exec/claude-code.js';
import { CodexHarness, readCodexRunHistory } from '../exec/codex.js';
import { CLAUDE_CODE_HARNESS, CODEX_HARNESS, MOXXY_HARNESS } from './harnesses.js';
import { GatewayPool } from '../exec/gateway-pool.js';
import { configuredProviderNames } from '../exec/home.js';
import { loadHistoryWithFallback } from '../exec/history.js';
import { runMoxxyProvision } from '../exec/provision.js';
import type { Checkouts } from '../exec/checkouts.js';
import { MIN_MOXXY_VERSION } from '../exec/cli.js';
import { cleanupRunnerStorage } from '../exec/storage-cleanup.js';
import { runVerify } from '../exec/verify.js';
import type { RunnerBackend, RunnerEventSink } from './backend.js';

/** What a run executes as on this machine, read off its row when it starts. */
export interface LocalRunSpec {
  readonly harness: string;
  readonly model: string | null;
}

/**
 * What this backend has to ask the layer that owns the rows: which runtime a
 * run executes through, and which ones this machine is set to run at all.
 * Injected rather than looked up, because both answers are rows the execution
 * primitives must not know how to read.
 */
export interface LocalRunnerHost {
  runSpec(runId: string): LocalRunSpec;
  /** Harness ids this machine runs work through, in preference order. */
  harnesses(): readonly string[];
  /**
   * Whether the runtime a run started here would actually take is installed and
   * able to complete a turn. Answered by the layer that owns detection, and
   * expected to be cached: health polls this every thirty seconds.
   */
  readiness(harnessId: string): Promise<{ readonly ok: boolean; readonly detail: string | null }>;
}

const MOXXY_ONLY: LocalRunnerHost = {
  runSpec: () => ({ harness: MOXXY_HARNESS.id, model: null }),
  harnesses: () => [MOXXY_HARNESS.id],
  readiness: async () => ({ ok: true, detail: null }),
};

/**
 * The built-in runner: companiond's own machine. Wraps the existing
 * GatewayPool + Checkouts + on-disk history so the local execution path is
 * byte-for-byte what it was before runners existed.
 *
 * It is also the only backend that runs more than one harness. Which one a run
 * uses is the run's own recorded choice, and both answer the same `Harness`
 * contract, so everything above this class stays indifferent to it.
 */
export class LocalRunnerBackend implements RunnerBackend {
  readonly id: string;
  private readonly pool: GatewayPool;
  private readonly maxLive: number;
  /**
   * Live sessions of every harness that is not moxxy, keyed like the gateway
   * pool: one per run. They differ in what they spawn and agree on `Harness`,
   * which is the whole point of the contract, so nothing below this line asks
   * which kind a run is except where the answer is genuinely different.
   */
  private readonly sessions = new Map<string, ClaudeCodeHarness | CodexHarness>();

  constructor(
    id: string,
    private readonly checkouts: Checkouts,
    private readonly moxxyCliPath: string,
    private moxxyVersion: string | null,
    private moxxyCompatible: boolean,
    maxLive: number,
    private readonly sink: RunnerEventSink,
    private readonly host: LocalRunnerHost = MOXXY_ONLY,
  ) {
    this.id = id;
    this.maxLive = maxLive;
    this.pool = new GatewayPool(
      {
        onEvent: (runId, event) => sink.onEvent(runId, event),
        onTurnComplete: (runId, turnId) => sink.onTurnComplete(runId, turnId),
        onAsk: (runId, ask) => sink.onAsk(runId, ask),
        onAskResolved: (runId, requestId) => sink.onAskResolved(runId, requestId),
        onGone: (runId) => sink.onGone(runId),
      },
      maxLive,
    );
  }

  /** After an in-place CLI upgrade: health re-advertises without a daemon restart. */
  updateMoxxyCli(version: string | null, compatible: boolean): void {
    this.moxxyVersion = version;
    this.moxxyCompatible = compatible;
  }

  /**
   * Health is judged against the runtime a run started here would actually
   * take, which is the machine's FIRST choice and nothing else.
   *
   * Two ways to get this wrong, and both make a machine lie. Judging on moxxy
   * regardless leaves a machine moved to another runtime degraded for missing
   * something it was told not to use, and reports a machine as online when the
   * runtime it does use has been uninstalled. Judging on "moxxy is anywhere in
   * the set" takes the whole machine offline for a fallback no run reaches.
   */
  async probe(): Promise<RunnerHealth> {
    const takes = this.host.harnesses()[0] ?? MOXXY_HARNESS.id;
    const { ok, detail } =
      takes === MOXXY_HARNESS.id
        ? {
            ok: this.moxxyCompatible,
            detail: this.moxxyCompatible ? null : `moxxy is missing or older than ${MIN_MOXXY_VERSION}`,
          }
        : await this.host.readiness(takes);
    return {
      status: ok ? 'online' : 'degraded',
      moxxyVersion: this.moxxyVersion,
      moxxyCompatible: this.moxxyCompatible,
      liveRuns: this.liveIds().length,
      maxRuns: this.maxLive,
      lastSeenAt: Date.now(),
      detail,
      providers: configuredProviderNames(),
    };
  }

  /** Companion's own isolated moxxy home: the one every gateway here boots against. */
  provisionProvider(spec: ProvisionProviderSpec): Promise<void> {
    return runMoxxyProvision(this.moxxyCliPath, paths.moxxyHome(), spec);
  }

  async spawn(runId: string, cwd: string): Promise<void> {
    mkdirSync(cwd, { recursive: true });
    const spec = this.host.runSpec(runId);
    // Named rather than "everything that is not moxxy": a run recorded under a
    // harness this build no longer has must land on moxxy, which is what every
    // machine ran before the choice existed, not on whichever branch happens to
    // be last.
    if (spec.harness !== CLAUDE_CODE_HARNESS.id && spec.harness !== CODEX_HARNESS.id) {
      await this.pool.spawn({ runId, cwd, moxxyCliPath: this.moxxyCliPath });
      return;
    }
    if (this.sessions.has(runId)) return;
    if (this.liveIds().length >= this.maxLive) {
      throw new Error(`this machine is running ${this.maxLive} agents already; stop one first`);
    }
    const handlers = {
      onEvent: (event: HarnessEvent) => this.sink.onEvent(runId, event),
      onTurnComplete: ({ turnId }: { turnId?: string }) => this.sink.onTurnComplete(runId, turnId),
      onClose: () => {
        this.sessions.delete(runId);
        this.sink.onGone(runId);
      },
    };
    const harness =
      spec.harness === CODEX_HARNESS.id
        ? new CodexHarness({ runId, cwd, cliPath: 'codex', model: spec.model }, handlers)
        : new ClaudeCodeHarness({ runId, cwd, cliPath: 'claude', model: spec.model }, handlers);
    await harness.connect();
    this.sessions.set(runId, harness);
  }

  async stop(runId: string): Promise<void> {
    const session = this.sessions.get(runId);
    if (session) {
      this.sessions.delete(runId);
      session.close();
      // A closed session raises no onClose of its own, and the run is no longer
      // live either way: the gateway pool announces the same thing here.
      this.sink.onGone(runId);
      return;
    }
    const handle = this.pool.get(runId);
    if (handle) await handle.stop();
  }

  isLive(runId: string): boolean {
    return this.sessions.get(runId)?.isOpen ?? this.pool.get(runId)?.client.isOpen ?? false;
  }

  liveIds(): string[] {
    return [...this.pool.liveIds(), ...this.sessions.keys()];
  }

  /** The run's harness, whichever kind it is. All of them answer one contract. */
  private live(runId: string): Harness {
    const session = this.sessions.get(runId);
    if (session?.isOpen) return session;
    const handle = this.pool.get(runId);
    if (!handle || !handle.client.isOpen) throw new Error(`run ${runId} has no live gateway (resume it first)`);
    return handle.client;
  }

  /**
   * The moxxy-only surface. A harness whose capabilities say it has no live
   * session controls is asked for none of this, so reaching one here is a
   * caller that skipped the check rather than a harness that fell short.
   */
  private controls(runId: string): HarnessSessionControls {
    const handle = this.pool.get(runId);
    if (!handle || !handle.client.isOpen) {
      throw new Error(`run ${runId} runs on a harness with no live session controls`);
    }
    return handle.client;
  }

  runTurn(runId: string, args: RunTurnArgs): Promise<RunTurnResult> {
    return this.live(runId).runTurn(args);
  }
  abortTurn(runId: string, turnId?: string): Promise<void> {
    return this.live(runId).abortTurn(turnId);
  }
  sessionInfo(runId: string): Promise<unknown> {
    return this.live(runId).sessionInfo();
  }
  setMode(runId: string, mode: string): Promise<void> {
    return this.controls(runId).setMode(mode);
  }
  setModel(runId: string, model: string | null): Promise<void> {
    return this.controls(runId).setModel(model);
  }
  setProvider(runId: string, provider: string): Promise<void> {
    return this.controls(runId).setProvider(provider);
  }
  runCommand(runId: string, name: string, args?: string): Promise<unknown> {
    return this.controls(runId).runCommand(name, args);
  }
  respondAsk(runId: string, requestId: string, response: AskResponse): Promise<void> {
    return this.live(runId).respondAsk(requestId, response);
  }

  async loadHistory(runId: string, before: number | null, limit: number): Promise<HistorySegment> {
    // Claude Code and Codex each keep their own transcript, live in memory and
    // on disk after, so their harness answers both cases and there is no moxxy
    // session to fall back to. The reaped reader is the one thing that cannot
    // be shared: the two write different files.
    const harness = this.host.runSpec(runId).harness;
    if (harness === CLAUDE_CODE_HARNESS.id || harness === CODEX_HARNESS.id) {
      const session = this.sessions.get(runId);
      if (session?.isOpen) return session.loadHistory(runId, before, limit);
      return harness === CODEX_HARNESS.id
        ? readCodexRunHistory(runId, before, limit)
        : readClaudeRunHistory(runId, before, limit);
    }
    const handle = this.pool.get(runId);
    return loadHistoryWithFallback(
      handle?.client.isOpen ? () => handle.client.loadHistory(runId, before, limit) : null,
      runId,
      before,
      limit,
    );
  }

  async writeFile(cwd: string, relPath: string, content: string): Promise<void> {
    const target = join(cwd, relPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, { mode: 0o600 });
  }

  // ---------- git working area ----------

  async scratchDir(runId: string): Promise<string> {
    const dir = join(paths.scratch(), runId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  async hasClone(repo: string): Promise<boolean> {
    return this.checkouts.hasClone(repo);
  }
  async cloneDir(repo: string): Promise<string> {
    return this.checkouts.cloneDir(repo);
  }
  async ensureClone(repo: string, username?: string | null): Promise<void> {
    await this.checkouts.clone(repo, undefined, username);
  }
  fetchOrigin(repo: string, username?: string | null): Promise<void> {
    return this.checkouts.fetch(repo, undefined, username);
  }
  addWorktree(repo: string, key: string, branch: string, baseBranch: string, username?: string | null): Promise<string> {
    return this.checkouts.addWorktree(repo, key, branch, baseBranch, undefined, username);
  }
  addWorktreeAtBranch(repo: string, key: string, branch: string, username?: string | null): Promise<string> {
    return this.checkouts.addWorktreeAtBranch(repo, key, branch, undefined, username);
  }
  removeWorktree(repo: string, cwd: string): Promise<void> {
    return this.checkouts.removeWorktree(repo, cwd);
  }
  diffVsBase(cwd: string, baseBranch: string): Promise<string> {
    return this.checkouts.diffVsBase(cwd, baseBranch);
  }
  commitAll(cwd: string, message: string): Promise<void> {
    return this.checkouts.commitAll(cwd, message);
  }
  /** This machine runs it directly; there is no agent hop to degrade through. */
  verify(cwd: string, command: string, timeoutMs?: number): Promise<AgentVerifyResponse> {
    return runVerify(cwd, command, timeoutMs);
  }

  push(repo: string, cwd: string, branch: string, username?: string | null): Promise<void> {
    return this.checkouts.push(repo, cwd, branch, undefined, username);
  }

  cleanupStorage(request: AgentStorageCleanupRequest): Promise<AgentStorageCleanupResponse> {
    // Every live run, not just the gateway pool's: reaping the working
    // directory out from under a live Claude Code session is the same bug.
    return cleanupRunnerStorage(request, this.checkouts, this.liveIds());
  }

  /** Reap every live session, of any kind (daemon shutdown). */
  async stopAll(): Promise<void> {
    for (const [, session] of this.sessions) session.close();
    this.sessions.clear();
    await this.pool.stopAll();
  }
}
