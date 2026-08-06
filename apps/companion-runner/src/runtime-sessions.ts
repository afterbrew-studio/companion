import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { paths } from '@moxxy/companion-services';
import {
  DEFAULT_LIMITS,
  RUNTIME_HARNESS_ID,
  RuntimeHarness,
  readRuntimeRunHistory,
  type ResolvedModelSpec,
  type RuntimeLimits,
} from '@moxxy/companion-runtime';
import type { AgentRunAccess, Harness, HarnessEvent, HistorySegment } from '@moxxy/companion-types';
import type { RunnerConfig } from './config.js';
import { log } from './log.js';

/**
 * The built-in runtime, running on this machine.
 *
 * Unlike moxxy, Claude Code or Codex it is not installed here: it is a
 * subprocess of this bundle, which is what makes a runner a plain container.
 * What it still needs is a model, and there are exactly two places one can come
 * from, in this order:
 *
 *  1. the spawn request, when the controlling Companion holds the credentials
 *     AND reached this machine over https (the daemon refuses to put a key on
 *     a plain-http wire, so an http runner simply never receives one);
 *  2. this machine's own configuration, the same ownership rule
 *     `COMPANION_RUNNER_GITHUB_TOKEN` follows for git.
 *
 * With neither, a spawn fails here and says so, which is a better answer than
 * a run that starts and cannot complete a turn.
 */
export class RuntimeSessions {
  private readonly sessions = new Map<string, Harness>();

  constructor(
    private readonly config: RunnerConfig,
    private readonly onEvent: (runId: string, event: HarnessEvent) => void,
    private readonly onTurnComplete: (runId: string, turnId?: string) => void,
    private readonly onGone: (runId: string) => void,
    private readonly onAsk: (runId: string, ask: unknown) => void = () => undefined,
    private readonly onAskResolved: (runId: string, requestId: string) => void = () => undefined,
  ) {}

  /**
   * What health reports.
   *
   * With no local model this says `unavailable` and flags `needsModel`, rather
   * than claiming ready and refusing on the first spawn. Whether the gap
   * actually matters is the daemon's to decide: it knows whether it reaches
   * this machine over https and may therefore send a model with the run, and it
   * upgrades the answer when it can.
   */
  get state(): { ready: boolean; detail: string | null; needsModel: boolean } {
    if (!existsSync(childPath())) {
      return { ready: false, detail: 'this runner build carries no agent child bundle', needsModel: false };
    }
    if (this.config.provider === null) {
      return {
        ready: false,
        detail:
          'No model is configured on this machine. Set COMPANION_RUNNER_PROVIDER_KIND and COMPANION_RUNNER_MODEL, or reach this runner over https so Companion can send one.',
        needsModel: true,
      };
    }
    return { ready: true, detail: null, needsModel: false };
  }

  has(runId: string): boolean {
    return this.sessions.has(runId);
  }

  get(runId: string): Harness | null {
    return this.sessions.get(runId) ?? null;
  }

  get liveCount(): number {
    return this.sessions.size;
  }

  async spawn(args: {
    runId: string;
    cwd: string;
    access: AgentRunAccess;
    spec?: unknown;
    limits?: unknown;
    verifyCommand?: string;
    resultSchema?: unknown;
    attended?: boolean;
  }): Promise<void> {
    if (this.sessions.has(args.runId)) return;
    const spec = (args.spec as ResolvedModelSpec | undefined) ?? this.config.provider;
    if (!spec) {
      throw new Error(
        'this runner has no model configured and the controlling Companion sent none (a key is only sent over https)',
      );
    }
    const files = runFiles(args.runId);
    const harness = new RuntimeHarness(
      {
        runId: args.runId,
        cwd: args.cwd,
        access: args.access,
        spec,
        childPath: childPath(),
        limits: (args.limits as RuntimeLimits | undefined) ?? DEFAULT_LIMITS,
        eventsPath: files.eventsPath,
        statePath: files.statePath,
        ...(args.verifyCommand ? { verifyCommand: args.verifyCommand } : {}),
        ...(args.resultSchema !== undefined ? { resultSchema: args.resultSchema } : {}),
        approvals: args.attended === true ? 'interactive' : 'policy',
      },
      {
        onEvent: (event) => this.onEvent(args.runId, event),
        onTurnComplete: ({ turnId }) => this.onTurnComplete(args.runId, turnId),
        onAsk: (ask) => this.onAsk(args.runId, ask),
        onAskResolved: (requestId) => this.onAskResolved(args.runId, requestId),
        onClose: () => {
          this.sessions.delete(args.runId);
          this.onGone(args.runId);
        },
      },
    );
    await harness.connect();
    this.sessions.set(args.runId, harness);
    log.info('started a built-in runtime session', { runId: args.runId, provider: spec.providerId });
  }

  async stop(runId: string): Promise<void> {
    const session = this.sessions.get(runId);
    if (!session) return;
    this.sessions.delete(runId);
    session.close();
    this.onGone(runId);
  }

  async stopAll(): Promise<void> {
    for (const [, session] of this.sessions) session.close();
    this.sessions.clear();
  }

  /** A live session answers from memory; a reaped one from the file it wrote. */
  history(runId: string, before: number | null, limit: number): Promise<HistorySegment> | HistorySegment {
    const session = this.sessions.get(runId);
    if (session) return session.loadHistory(runId, before, limit);
    return readRuntimeRunHistory(runFiles(runId).eventsPath, before, limit);
  }
}

export { RUNTIME_HARNESS_ID };

/**
 * The child bundle, emitted beside this one by the runner's own build. There is
 * no package to resolve at run time: the published agent is a single file plus
 * its child, which is the whole reason a runner needs no checkout.
 */
export function childPath(): string {
  const entry = process.argv[1];
  return entry ? join(dirname(entry), 'agent.js') : 'agent.js';
}

function runFiles(runId: string): { eventsPath: string; statePath: string } {
  const dir = join(paths.runConfigs(), runId);
  return { eventsPath: join(dir, 'runtime-events.jsonl'), statePath: join(dir, 'runtime-state.json') };
}
