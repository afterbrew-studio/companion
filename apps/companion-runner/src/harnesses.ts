import { mkdirSync } from 'node:fs';
import { paths } from '@moxxy/companion-services';
import {
  ClaudeCodeHarness,
  CodexHarness,
  detectHarnesses,
  readClaudeRunHistory,
  readCodexRunHistory,
  type HarnessDetection,
} from '@companion/module-operate/exec';
import type {
  AgentRunAccess,
  AgentRuntimeHealth,
  Harness,
  HarnessEvent,
  HistorySegment,
} from '@moxxy/companion-types';
import { log } from './log.js';

/**
 * The agent CLIs this machine may have, run here rather than on the daemon's.
 *
 * This is the whole point of attaching a developer laptop: Claude Code and
 * Codex sign in on the machine they are installed on, so the box that holds the
 * credential is the only box that can complete a turn with it. companiond's own
 * machine runs exactly these two the same way (`LocalRunnerBackend`), and both
 * sides answer the one `Harness` contract, so nothing above this line has to
 * know which side a run landed on.
 */
const CLI_HARNESSES: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
};

export const MOXXY_HARNESS_ID = 'moxxy';

/** Names a runtime this build knows how to start, whatever it was detected as. */
export function isCliHarness(id: string | undefined): id is 'claude-code' | 'codex' {
  return id !== undefined && id in CLI_HARNESSES;
}

/**
 * Detection is two `execFile` calls per runtime (is it there, and is it usable),
 * and the daemon polls health every thirty seconds. What it answers changes only
 * when software is installed or signed into, so a short cache costs nothing and
 * a stale minute costs less than a fistful of processes per poll.
 */
const DETECT_TTL_MS = 60_000;

/** Runs kept addressable for history after they end; bounds a long uptime. */
const REAPED_LIMIT = 1_000;

export class CliHarnessSessions {
  private readonly sessions = new Map<string, Harness>();
  /**
   * Which runtime each run was started under, so a REAPED run still reads the
   * right transcript: Claude Code and Codex write different files, and the
   * history request that arrives after the session is gone carries no session
   * to ask. The daemon also sends the id explicitly, which is what survives a
   * restart of this agent; this map is what answers before it has to.
   */
  private readonly ranUnder = new Map<string, string>();
  private detected: readonly HarnessDetection[] | null = null;
  private detectedAt = 0;

  constructor(
    private readonly onEvent: (runId: string, event: HarnessEvent) => void,
    private readonly onTurnComplete: (runId: string, turnId?: string) => void,
    private readonly onGone: (runId: string) => void,
  ) {}

  get liveCount(): number {
    return this.sessions.size;
  }

  has(runId: string): boolean {
    return this.sessions.has(runId);
  }

  get(runId: string): Harness | null {
    return this.sessions.get(runId) ?? null;
  }

  liveIds(): string[] {
    return [...this.sessions.keys()];
  }

  /**
   * What this machine could run work through, read off disk.
   *
   * A runtime that is not installed is left out rather than reported
   * unavailable: the daemon offers the operator exactly this list, and
   * advertising software they have not installed turns a setup step into a
   * catalogue. `installed` (there, but signed out or too old) IS reported, with
   * the detail, because that one is worth fixing.
   */
  async runtimes(): Promise<AgentRuntimeHealth[]> {
    const now = Date.now();
    if (!this.detected || this.detectedAt + DETECT_TTL_MS <= now) {
      this.detectedAt = now;
      this.detected = await detectHarnesses(paths.moxxyHome());
    }
    return this.detected.flatMap((detection): AgentRuntimeHealth[] => {
      if (detection.state === 'absent') return [];
      const label = CLI_HARNESSES[detection.id] ?? (detection.id === MOXXY_HARNESS_ID ? 'Moxxy' : detection.id);
      return [
        {
          id: detection.id,
          label,
          version: detection.version,
          state: detection.state === 'ready' ? 'ready' : 'unavailable',
          // The fix is a command to run on THIS machine, so it belongs in the
          // detail: the daemon's runner page cannot run it and the operator
          // reading it is sitting somewhere else entirely.
          detail: detection.fix ? `${detection.detail ?? ''} Run: ${detection.fix}`.trim() : detection.detail,
        },
      ];
    });
  }

  /** Forget the cache: something that changes what is installed just happened. */
  forgetDetection(): void {
    this.detectedAt = 0;
  }

  async spawn(args: {
    runId: string;
    cwd: string;
    access: AgentRunAccess;
    harness: 'claude-code' | 'codex';
    model?: string | null;
  }): Promise<void> {
    if (this.sessions.has(args.runId)) return;
    const installed = (await this.runtimes()).find((runtime) => runtime.id === args.harness);
    if (!installed) throw new Error(`${CLI_HARNESSES[args.harness]} is not installed on this machine`);
    if (installed.state !== 'ready') {
      throw new Error(installed.detail ?? `${CLI_HARNESSES[args.harness]} cannot complete a turn on this machine`);
    }
    mkdirSync(args.cwd, { recursive: true });
    const handlers = {
      onEvent: (event: HarnessEvent) => this.onEvent(args.runId, event),
      onTurnComplete: ({ turnId }: { turnId?: string }) => this.onTurnComplete(args.runId, turnId),
      onClose: () => {
        this.sessions.delete(args.runId);
        this.onGone(args.runId);
      },
    };
    const options = {
      runId: args.runId,
      cwd: args.cwd,
      cliPath: args.harness === 'codex' ? 'codex' : 'claude',
      model: args.model ?? null,
      access: args.access,
    };
    const harness =
      args.harness === 'codex' ? new CodexHarness(options, handlers) : new ClaudeCodeHarness(options, handlers);
    await harness.connect();
    this.sessions.set(args.runId, harness);
    this.remember(args.runId, args.harness);
    log.info('started a CLI harness session', { runId: args.runId, harness: args.harness });
  }

  async stop(runId: string): Promise<void> {
    const session = this.sessions.get(runId);
    if (!session) return;
    this.sessions.delete(runId);
    session.close();
    // A closed session raises no onClose of its own, and the run is no longer
    // live either way.
    this.onGone(runId);
  }

  async stopAll(): Promise<void> {
    for (const [, session] of this.sessions) session.close();
    this.sessions.clear();
  }

  /**
   * A live session answers from memory; a reaped one from the file its runtime
   * wrote. `harness` is the daemon's answer, which is the only one that
   * survives a restart of this agent: it holds the run row.
   */
  history(runId: string, harness: string | null, before: number | null, limit: number): Promise<HistorySegment> {
    const session = this.sessions.get(runId);
    if (session) return session.loadHistory(runId, before, limit);
    const ran = harness ?? this.ranUnder.get(runId) ?? null;
    if (ran === 'codex') return Promise.resolve(readCodexRunHistory(runId, before, limit));
    return Promise.resolve(readClaudeRunHistory(runId, before, limit));
  }

  /** Whether this run is one of ours at all: live now or served earlier. */
  served(runId: string, harness: string | null): boolean {
    return this.sessions.has(runId) || isCliHarness(harness ?? this.ranUnder.get(runId));
  }

  private remember(runId: string, harness: string): void {
    if (this.ranUnder.size >= REAPED_LIMIT) {
      const oldest = this.ranUnder.keys().next();
      if (!oldest.done) this.ranUnder.delete(oldest.value);
    }
    this.ranUnder.set(runId, harness);
  }
}
