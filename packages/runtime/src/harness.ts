import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  AskResponse,
  Harness,
  HarnessCapabilities,
  HarnessEvent,
  HistorySegment,
  RunTurnArgs,
  RunTurnResult,
} from '@moxxy/companion-types';
import { takeLines, type RuntimeCommand, type RuntimeFrame } from './protocol.js';
import { DEFAULT_LIMITS, type ResolvedModelSpec, type RuntimeAccess, type RuntimeLimits } from './spec.js';

/**
 * Companion's own harness: one child process per run, spawned from this
 * bundle's own Node, so unlike every other harness it cannot be missing from a
 * machine and has no interactive sign-in.
 *
 * What it declares, rather than fakes:
 *  - permission can be answered one call at a time, which is the one thing no
 *    other harness Companion runs can do: the others settle it as a start-time
 *    policy and offer no headless round trip. Whether a given run actually
 *    asks is the RUN's answer, not this one: unattended work has nobody to
 *    answer and would sit until its turn timed out.
 *  - the session is not reconfigurable while it runs: the model is chosen when
 *    the spec is resolved, so every session control is off.
 *  - models come from the operator's own provider records, which is what
 *    `providers` means.
 */
export const RUNTIME_CAPABILITIES: HarnessCapabilities = {
  approvals: 'interactive',
  usage: 'tokens',
  models: 'providers',
  sessionControls: { model: false, provider: false, mode: false, autoApprove: false, commands: false },
};

export const RUNTIME_HARNESS_ID = 'companion';

export interface RuntimeHarnessOptions {
  readonly runId: string;
  readonly cwd: string;
  readonly access: RuntimeAccess;
  readonly spec: ResolvedModelSpec;
  /** Absolute path to the child bundle this build carries. */
  readonly childPath: string;
  readonly limits?: RuntimeLimits;
  readonly instructions?: string;
  /** Display transcript, so a reaped run still renders. */
  readonly eventsPath?: string;
  /** Model-facing continuation record, so a restarted run resumes. */
  readonly statePath?: string;
  /** The repository's own verification command, when one is configured. */
  readonly verifyCommand?: string;
  /** JSON Schema the caller wants the answer in (structured one-shots). */
  readonly resultSchema?: unknown;
  /** Scoped access back to this instance, for platform-operating runs. */
  readonly companionApi?: { readonly baseUrl: string; readonly token: string };
  /** `interactive` only for a run somebody is watching. See the capability. */
  readonly approvals?: 'policy' | 'interactive';
  /**
   * Every model this machine may run, not just the one this run resolved to.
   * `sessionInfo` is how the runner registry learns a machine's catalog, and a
   * session that reported only its own model would shrink the machine's catalog
   * to one entry on every refresh.
   */
  readonly catalog?: readonly {
    readonly name: string;
    readonly enabled: boolean;
    readonly ready: boolean;
    readonly models: readonly { readonly id: string; readonly contextWindow: number | null }[];
  }[];
}

export interface RuntimeHarnessHandlers {
  onEvent?(event: HarnessEvent): void;
  onTurnComplete?(payload: { turnId?: string }): void;
  onAsk?(ask: unknown): void;
  onAskResolved?(requestId: string): void;
  onClose?(): void;
}

export class RuntimeHarness implements Harness {
  readonly capabilities = RUNTIME_CAPABILITIES;
  readonly sessionId: string;

  private proc: ChildProcess | null = null;
  private stdoutTail = '';
  private stderrTail = '';
  private closed = false;
  private turns = 0;
  private inFlight: { turnId: string; done: () => void } | null = null;
  private readonly recent: HarnessEvent[] = [];
  private static readonly RECENT_LIMIT = 2_000;
  private readonly limits: RuntimeLimits;

  constructor(
    private readonly opts: RuntimeHarnessOptions,
    private readonly handlers: RuntimeHarnessHandlers,
  ) {
    this.sessionId = opts.runId;
    this.limits = opts.limits ?? DEFAULT_LIMITS;
    this.recent.push(...readRuntimeEvents(opts.eventsPath).slice(-RuntimeHarness.RECENT_LIMIT));
  }

  async connect(settleMs = 300): Promise<void> {
    if (this.proc) return;
    const proc = spawn(
      process.execPath,
      [`--max-old-space-size=${this.limits.memoryMb}`, this.opts.childPath],
      {
        cwd: this.opts.cwd,
        // The child inherits no credential from the daemon's environment: its
        // key arrives on the start frame and nothing else is passed through.
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: process.env.NODE_ENV ?? '' },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    this.proc = proc;

    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => {
      this.stdoutTail = takeLines(this.stdoutTail + chunk, (line) => this.onFrame(line));
    });
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4_000);
    });
    // A stream or child emitting `error` with nothing listening throws on the
    // process itself, so one dead pipe would take the daemon down with it.
    const note = (err: Error): void => {
      this.stderrTail = `${this.stderrTail}${err.message}`.slice(-4_000);
    };
    proc.on('error', note);
    proc.stdin?.on('error', note);
    proc.once('exit', () => {
      this.proc = null;
      this.settleTurn();
      if (!this.closed) this.handlers.onClose?.();
    });

    this.send({
      t: 'start',
      sessionId: this.sessionId,
      cwd: this.opts.cwd,
      access: this.opts.access,
      spec: this.opts.spec,
      limits: this.limits,
      ...(this.opts.instructions ? { instructions: this.opts.instructions } : {}),
      ...(this.opts.statePath ? { statePath: this.opts.statePath } : {}),
      ...(this.opts.verifyCommand ? { verifyCommand: this.opts.verifyCommand } : {}),
      ...(this.opts.resultSchema !== undefined ? { resultSchema: this.opts.resultSchema } : {}),
      ...(this.opts.companionApi ? { companionApi: this.opts.companionApi } : {}),
      ...(this.opts.approvals ? { approvals: this.opts.approvals } : {}),
    });

    await new Promise((resolve) => setTimeout(resolve, settleMs));
    if (!this.isOpen) {
      throw new Error(`the built-in runtime exited during startup: ${this.stderrTail.slice(-300) || 'no output'}`);
    }
  }

  close(): void {
    this.closed = true;
    this.settleTurn();
    this.terminate();
  }

  private terminate(): void {
    const proc = this.proc;
    this.proc = null;
    if (!proc) return;
    proc.stdin?.end();
    proc.kill('SIGTERM');
    setTimeout(() => proc.kill('SIGKILL'), 3_000).unref();
  }

  get isOpen(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  async runTurn(args: RunTurnArgs): Promise<RunTurnResult> {
    if (!this.proc?.stdin?.writable) throw new Error(`the runtime session for ${this.opts.runId} is not running`);
    if (this.inFlight) throw new Error(`a turn is already running on ${this.opts.runId}`);
    const turnId = `${this.sessionId}:t${++this.turns}`;
    this.inFlight = { turnId, done: () => this.handlers.onTurnComplete?.({ turnId }) };
    this.send({ t: 'turn', turnId, prompt: args.prompt });
    return { turnId };
  }

  /** The turn is cancelled; the session survives and can be prompted again. */
  async abortTurn(): Promise<void> {
    if (this.isOpen) this.send({ t: 'abort' });
    else this.settleTurn();
  }

  /**
   * What this machine can run, shaped so the existing catalog reader
   * understands it. The whole configured catalog rather than this run's own
   * model: the runner registry refreshes a machine's catalog off any live
   * session, so answering with one model would shrink it to one on every run.
   */
  async sessionInfo(): Promise<unknown> {
    const provider = this.opts.spec.providerId;
    const catalog = this.opts.catalog ?? [
      { name: provider, enabled: true, ready: true, models: [{ id: this.opts.spec.model, contextWindow: null }] },
    ];
    return {
      activeProvider: provider,
      readyProviders: catalog.filter((entry) => entry.ready).map((entry) => entry.name),
      providers: catalog,
      tools: [],
      permissionMode: this.opts.access,
      slashCommands: [],
    };
  }

  /**
   * A person answered an approval this run raised. Written down the same pipe
   * the ask came up, so the waiting tool call resumes or is refused.
   */
  async respondAsk(requestId: string, response: AskResponse): Promise<void> {
    this.send({ t: 'ask.response', requestId, response: { ...response } });
  }

  async loadHistory(_workspaceId: string, before: number | null, limit: number): Promise<HistorySegment> {
    const events = this.isOpen ? this.recent : readRuntimeEvents(this.opts.eventsPath);
    return segment(events, before, limit);
  }

  private send(command: RuntimeCommand): void {
    this.proc?.stdin?.write(`${JSON.stringify(command)}\n`);
  }

  private onFrame(line: string): void {
    let frame: RuntimeFrame;
    try {
      frame = JSON.parse(line) as RuntimeFrame;
    } catch {
      return; // one garbled line must not stop the stream
    }
    switch (frame.t) {
      case 'event':
        this.record(frame.event as HarnessEvent);
        break;
      case 'turn.end':
        this.settleTurn();
        break;
      case 'ask':
        this.handlers.onAsk?.(frame.ask);
        break;
      case 'ask.resolved':
        this.handlers.onAskResolved?.(frame.requestId);
        break;
      case 'fatal':
        this.stderrTail = `${this.stderrTail}${frame.message}`.slice(-4_000);
        break;
      case 'ready':
        break;
    }
  }

  private record(event: HarnessEvent): void {
    this.recent.push(event);
    if (this.recent.length > RuntimeHarness.RECENT_LIMIT) {
      this.recent.splice(0, this.recent.length - RuntimeHarness.RECENT_LIMIT);
    }
    if (this.opts.eventsPath) {
      try {
        mkdirSync(dirname(this.opts.eventsPath), { recursive: true });
        appendFileSync(this.opts.eventsPath, `${JSON.stringify(event)}\n`);
      } catch {
        // the live stream matters more than the replay copy
      }
    }
    try {
      this.handlers.onEvent?.(event);
    } catch {
      // a consumer that throws must not stop the read loop
    }
  }

  private settleTurn(): void {
    const turn = this.inFlight;
    this.inFlight = null;
    turn?.done();
  }
}

/** A reaped run's transcript: the events file this harness wrote as it went. */
export function readRuntimeRunHistory(
  eventsPath: string,
  before: number | null,
  limit: number,
): HistorySegment {
  return segment(readRuntimeEvents(eventsPath), before, limit);
}

function segment(events: readonly HarnessEvent[], before: number | null, limit: number): HistorySegment {
  const end = before === null ? events.length : Math.min(before, events.length);
  const start = Math.max(0, end - limit);
  return { events: events.slice(start, end), prevCursor: start > 0 ? start : null };
}

function readRuntimeEvents(path: string | undefined): HarnessEvent[] {
  if (!path) return [];
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const events: HarnessEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as HarnessEvent);
    } catch {
      // tolerate corruption: one bad line must not hide the transcript
    }
  }
  return events;
}
