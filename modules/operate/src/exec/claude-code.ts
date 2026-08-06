import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type {
  AgentRunAccess,
  AskResponse,
  Harness,
  HarnessCapabilities,
  HarnessEvent,
  HistorySegment,
  RunTurnArgs,
  RunTurnResult,
} from '@moxxy/companion-types';
import { log } from '@moxxy/companion-services';
import { adaptFrames, ClaudeAdapter, type ClaudeSessionInfo, type ClaudeTurnSummary } from './claude-adapter.js';

const execFileP = promisify(execFile);

/**
 * Claude Code as a harness: one `claude --print --input-format stream-json`
 * process per run, fed a JSON line per turn.
 *
 * Streaming input is what makes this a session rather than one prompt: the
 * process stays up between turns, so a run can be prompted again, and the
 * transcript is one session id throughout.
 *
 * What it cannot do, declared rather than faked:
 *  - permission is a POLICY, chosen when the process starts. There is no
 *    headless round trip, so `respondAsk` can only ever be a no-op and no ask
 *    is ever raised.
 *  - the session cannot be reconfigured while it runs (model, provider, mode
 *    and slash commands are all start-time flags), so every session control is
 *    off and callers check before reaching for one.
 *  - it signs in on its own, so its models are not a provider question.
 */
export const CLAUDE_CODE_CAPABILITIES: HarnessCapabilities = {
  approvals: 'policy',
  usage: 'tokens',
  models: 'builtin',
  sessionControls: { model: false, provider: false, mode: false, autoApprove: false, commands: false },
};

/**
 * The model aliases Claude Code accepts on `--model`. Deliberately the aliases
 * and not a version list: they always resolve to the current release, so this
 * does not go stale, and the resolved id is reported per session by
 * `system/init` and added to the catalog from there.
 */
export const CLAUDE_MODEL_ALIASES = ['fable', 'opus', 'sonnet', 'haiku'] as const;

/** The provider name a Claude Code machine reports its models under. */
export const CLAUDE_PROVIDER = 'claude-code';

/**
 * Unattended work never parks on a human, so what fences it is the run's own
 * worktree, which holds no push credential: `Checkouts` supplies one per
 * operation and never writes it into the tree.
 *
 * This rule is the second layer and only that. It refuses the obvious spelling
 * of a push, matched as a prefix on the Bash tool's command, and does not
 * survive being wrapped in a shell. It is restated here because Claude Code
 * reads its own permission rules rather than moxxy's `permissions.json`.
 */
const DENIED_TOOLS = ['Bash(git push:*)'];

/**
 * Safe mode prevents repository CLAUDE.md files, hooks, plugins and MCP config
 * from becoming executable instructions merely because an untrusted PR was
 * checked out. Read-only runs additionally expose only non-mutating built-ins.
 */
export function claudeAccessArgs(access: AgentRunAccess): string[] {
  if (access === 'read-only') {
    return ['--safe-mode', '--permission-mode', 'dontAsk', '--tools', 'Read', 'Glob', 'Grep'];
  }
  return [
    '--safe-mode',
    '--permission-mode',
    'bypassPermissions',
    '--disallowedTools',
    ...DENIED_TOOLS,
  ];
}

export interface ClaudeCodeOptions {
  readonly runId: string;
  readonly cwd: string;
  readonly cliPath: string;
  /** `--model`; omitted lets Claude Code use the account default. */
  readonly model?: string | null;
  readonly access?: AgentRunAccess;
}

export interface ClaudeCodeHandlers {
  onEvent?(event: HarnessEvent): void;
  onTurnComplete?(payload: { turnId?: string }): void;
  onClose?(): void;
}

const TURN_TIMEOUT_MS = 30 * 60_000;

export class ClaudeCodeHarness implements Harness {
  readonly capabilities = CLAUDE_CODE_CAPABILITIES;

  private proc: ChildProcess | null = null;
  private adapter: ClaudeAdapter;
  private stdoutTail = '';
  private stderrTail = '';
  private closed = false;
  private turns = 0;
  private session: ClaudeSessionInfo | null = null;
  /**
   * The events this session has emitted, which is the only transcript a live
   * run has: Claude Code answers no history RPC. Bounded so a long-running
   * session cannot grow without limit; the on-disk session file is the
   * complete record and is what a reaped run reads.
   */
  private readonly recent: HarnessEvent[] = [];
  private static readonly RECENT_LIMIT = 2_000;

  /** Resolves when the turn in flight ends; the harness runs one at a time. */
  private inFlight: { turnId: string; done: () => void } | null = null;

  readonly sessionId: string;

  constructor(
    private readonly opts: ClaudeCodeOptions,
    private readonly handlers: ClaudeCodeHandlers,
  ) {
    this.sessionId = sessionUuid(opts.runId);
    this.adapter = this.newAdapter(0, 0);
  }

  private newAdapter(seq: number, turns: number): ClaudeAdapter {
    return new ClaudeAdapter(
      this.sessionId,
      {
        onEvent: (event) => this.record(event),
        onSessionInfo: (info) => (this.session = info),
        onTurnEnd: (summary) => this.endTurn(summary),
      },
      seq,
      turns,
    );
  }

  /**
   * Start the session process.
   *
   * There is no handshake to wait for: measured, `system/init` does not arrive
   * until the first turn is written, so nothing is emitted between spawn and
   * the first prompt. Readiness is therefore "it did not die", which is what
   * catches the failures a caller can act on (no binary, a rejected flag, a
   * working directory that does not exist). A refused sign-in surfaces on the
   * first turn, where the error belongs to that turn.
   */
  async connect(settleMs = 500): Promise<void> {
    if (this.proc) return;
    // What this session already said, replayed before the new process speaks.
    // A resumed run has its whole transcript on disk and none of it in memory,
    // so without this the run detail page would come back blank; numbering
    // continues past it so nothing collides with a replayed event.
    const replayed = readClaudeSession(this.sessionId);
    const resuming = replayed.length > 0 || existsSync(sessionFile(this.sessionId));
    if (replayed.length > 0) {
      this.recent.length = 0;
      this.recent.push(...replayed.slice(-ClaudeCodeHarness.RECENT_LIMIT));
      this.turns = replayed.filter((e) => e.type === 'user_prompt').length;
      this.adapter = this.newAdapter(replayed.length, this.turns);
    }
    const args = [
      '--print',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      // Permission is settled here, once, for the life of the session.
      ...claudeAccessArgs(this.opts.access ?? 'workspace-write'),
      resuming ? '--resume' : '--session-id',
      this.sessionId,
    ];
    if (this.opts.model) args.push('--model', this.opts.model);

    const proc = spawn(this.opts.cliPath, args, {
      cwd: this.opts.cwd,
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'companion' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;

    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4_000);
    });
    // A stream or child that emits `error` with nothing listening throws on the
    // process itself, so a missing binary, or a turn written to a pipe that
    // closed a moment earlier, would take the daemon down with it.
    const note = (err: Error): void => {
      this.stderrTail = `${this.stderrTail}${err.message}`.slice(-4_000);
    };
    proc.on('error', note);
    proc.stdin?.on('error', note);
    proc.once('exit', (code, signal) => {
      this.proc = null;
      this.adapter.end();
      // A turn still in flight when the process dies must not hang its caller.
      this.settleTurn();
      if (code !== 0 && !this.closed) {
        log.warn('claude code exited', { runId: this.opts.runId, code, signal, stderr: this.stderrTail.slice(-500) });
      }
      if (!this.closed) this.handlers.onClose?.();
    });

    await new Promise((resolve) => setTimeout(resolve, settleMs));
    if (!this.isOpen) {
      throw new Error(`claude code exited during startup: ${this.stderrTail.slice(-300) || 'no output'}`);
    }
  }

  /** Deliberate teardown by the owner: it already knows, so it is not told. */
  close(): void {
    this.closed = true;
    this.settleTurn();
    this.terminate();
  }

  private terminate(): void {
    const proc = this.proc;
    // Cleared before the process exits so `isOpen` is false the moment the
    // decision is made, not whenever the signal lands.
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
    const proc = this.proc;
    if (!proc?.stdin?.writable) throw new Error(`claude code session for ${this.opts.runId} is not running`);
    if (this.inFlight) throw new Error(`a turn is already running on ${this.opts.runId}`);

    const turnId = `${this.sessionId}:t${++this.turns}`;
    this.adapter.beginTurn(turnId, args.prompt);
    const frame = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: args.prompt }] },
    };
    // A turn that has produced no `result` in half an hour is not going to.
    // The session ends rather than just being declared over: releasing the slot
    // while the process still holds stdin would let the next prompt interleave
    // with a turn that is still running.
    const timer = setTimeout(() => void this.abortTurn(), TURN_TIMEOUT_MS);
    timer.unref();
    this.inFlight = {
      turnId,
      done: () => {
        clearTimeout(timer);
        this.handlers.onTurnComplete?.({ turnId });
      },
    };
    proc.stdin.write(`${JSON.stringify(frame)}\n`);
    return { turnId };
  }

  /**
   * There is no mid-turn interrupt on this contract, so aborting ends the
   * session. The run is stopped, not paused; its transcript survives on disk
   * and resuming starts a fresh process against the same session id.
   *
   * Unlike `close`, this announces itself: nobody asked for the session to go
   * away, so the owner has to hear that the run is no longer live.
   */
  async abortTurn(): Promise<void> {
    this.settleTurn();
    this.terminate();
  }

  /**
   * The session as `system/init` last reported it, shaped so the one catalog
   * reader understands it. `claude-code` is named as the provider because a
   * machine's models have to hang off something; that it is not a credential
   * the operator supplies is what `capabilities.models` says.
   */
  async sessionInfo(): Promise<unknown> {
    const resolved = this.session?.model;
    const models = [...CLAUDE_MODEL_ALIASES, ...(resolved ? [resolved] : [])];
    return {
      activeProvider: CLAUDE_PROVIDER,
      readyProviders: [CLAUDE_PROVIDER],
      providers: [
        {
          name: CLAUDE_PROVIDER,
          enabled: true,
          models: [...new Set(models)].map((id) => ({ id, contextWindow: null })),
        },
      ],
      tools: this.session?.tools ?? [],
      permissionMode:
        this.session?.permissionMode ??
        ((this.opts.access ?? 'workspace-write') === 'read-only' ? 'dontAsk/read-only' : 'bypassPermissions'),
      slashCommands: this.session?.slashCommands ?? [],
    };
  }

  /** No prompt is ever raised, so there is nothing to answer. */
  async respondAsk(_requestId: string, _response: AskResponse): Promise<void> {
    throw new Error('claude code settles permission by policy and raises no approval');
  }

  /**
   * A live session answers from memory, which `connect` seeded with whatever
   * was already on disk, so a resumed run replays in full. Once the process is
   * gone the file is the record.
   */
  async loadHistory(_workspaceId: string, before: number | null, limit: number): Promise<HistorySegment> {
    const events = this.isOpen ? this.recent : readClaudeSession(this.sessionId);
    const end = before === null ? events.length : Math.min(before, events.length);
    const start = Math.max(0, end - limit);
    return { events: events.slice(start, end), prevCursor: start > 0 ? start : null };
  }

  /** What `system/init` last said, for a caller that needs the resolved model. */
  get lastSessionInfo(): ClaudeSessionInfo | null {
    return this.session;
  }

  // ---------- wire -----------------------------------------------------------

  private onStdout(chunk: string): void {
    this.stdoutTail += chunk;
    let newline = this.stdoutTail.indexOf('\n');
    while (newline !== -1) {
      const line = this.stdoutTail.slice(0, newline).trim();
      this.stdoutTail = this.stdoutTail.slice(newline + 1);
      if (line.length > 0) {
        try {
          this.adapter.push(JSON.parse(line));
        } catch {
          // one garbled line must not stop the stream
        }
      }
      newline = this.stdoutTail.indexOf('\n');
    }
  }

  private record(event: HarnessEvent): void {
    this.recent.push(event);
    if (this.recent.length > ClaudeCodeHarness.RECENT_LIMIT) {
      this.recent.splice(0, this.recent.length - ClaudeCodeHarness.RECENT_LIMIT);
    }
    // A consumer that throws must not stop the read loop.
    try {
      this.handlers.onEvent?.(event);
    } catch {
      // isolated on purpose
    }
  }

  private endTurn(_summary: ClaudeTurnSummary): void {
    this.settleTurn();
  }

  private settleTurn(): void {
    const turn = this.inFlight;
    this.inFlight = null;
    turn?.done();
  }
}

/**
 * A stable session UUID for a run id. Claude Code's `--session-id` takes a
 * UUID and Companion's run ids are not one, so it is derived rather than
 * stored: the same run always resumes the same session, across restarts and
 * without a column.
 */
export function sessionUuid(runId: string): string {
  const h = createHash('sha1').update(`companion:claude-code:${runId}`).digest();
  const bytes = Buffer.from(h.subarray(0, 16));
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x50; // version 5
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Claude Code's own config root; `CLAUDE_CONFIG_DIR` moves it. */
function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude');
}

/**
 * Where Claude Code parked a session's transcript.
 *
 * The file sits under a per-project directory whose name Claude Code derives
 * from the working directory. That rule is Claude Code's, not ours, so this
 * looks the session id up by scanning the project directories instead of
 * reproducing it: a change to the naming leaves this working.
 */
export function sessionFile(sessionId: string): string {
  const projects = join(configDir(), 'projects');
  let dirs: string[];
  try {
    dirs = readdirSync(projects);
  } catch {
    return join(projects, `${sessionId}.jsonl`);
  }
  for (const dir of dirs) {
    const candidate = join(projects, dir, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return join(projects, `${sessionId}.jsonl`);
}

/**
 * A reaped run's transcript: Claude Code's own session file, read back through
 * the same adapter the live stream goes through. The file carries the prompts
 * the stream never echoes, so a replayed transcript is more complete than the
 * live one, not less.
 */
export function readClaudeRunHistory(runId: string, before: number | null, limit: number): HistorySegment {
  const events = readClaudeSession(sessionUuid(runId));
  const end = before === null ? events.length : Math.min(before, events.length);
  const start = Math.max(0, end - limit);
  return { events: events.slice(start, end), prevCursor: start > 0 ? start : null };
}

/** A reaped session's transcript, read back through the same adapter. */
export function readClaudeSession(sessionId: string): HarnessEvent[] {
  const file = sessionFile(sessionId);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const frames: unknown[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      frames.push(JSON.parse(line));
    } catch {
      // tolerate corruption: one bad line must not hide the transcript
    }
  }
  return adaptFrames(sessionId, frames);
}

export interface ClaudeCodeCli {
  readonly path: string;
  readonly version: string;
  /** `claude auth status --json` said so. Costs no turn and no API call. */
  readonly loggedIn: boolean;
}

/** Presence and readiness of the `claude` CLI, without spending a turn. */
export async function detectClaudeCode(cliPath = 'claude'): Promise<ClaudeCodeCli | null> {
  let version: string;
  try {
    const { stdout } = await execFileP(cliPath, ['--version'], { timeout: 15_000 });
    version = stdout.trim().split(/\s+/)[0] ?? '';
    if (!/^\d+\.\d+/.test(version)) return null;
  } catch {
    return null;
  }
  let loggedIn = false;
  try {
    const { stdout } = await execFileP(cliPath, ['auth', 'status', '--json'], { timeout: 20_000 });
    loggedIn = (JSON.parse(stdout) as { loggedIn?: unknown }).loggedIn === true;
  } catch {
    loggedIn = false;
  }
  return { path: cliPath, version, loggedIn };
}
