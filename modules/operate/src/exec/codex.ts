import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type {
  AskResponse,
  Harness,
  HarnessCapabilities,
  HarnessEvent,
  HistorySegment,
  RunTurnArgs,
  RunTurnResult,
} from '@moxxy/companion-types';
import { log, paths } from '@moxxy/companion-services';
import { adaptRollout, CodexAdapter, type CodexTurnSummary } from './codex-adapter.js';

const execFileP = promisify(execFile);

/**
 * Codex as a harness: one `codex exec --json` process per TURN, not per run.
 *
 * That is the structural difference from the other two. moxxy holds a gateway
 * and Claude Code holds a process fed a JSON line per turn, so for both of them
 * a session is something that stays up. `codex exec` answers one prompt and
 * exits; continuity comes from `codex exec resume <thread>`, which reads the
 * thread back off disk. So a Codex session here is a THREAD ID plus a working
 * directory, and being "open" means the run may still take another turn rather
 * than that anything is currently running.
 *
 * Two consequences worth stating rather than discovering:
 *  - aborting a turn does not end the session. The process dies, the thread
 *    survives on disk, and the next prompt resumes it. This is the one place
 *    Codex degrades better than Claude Code, whose abort has to end the run.
 *  - the thread id is only learned once the first turn has started, so it is
 *    persisted per run: nothing in the run row can hold it, and losing it turns
 *    a resumed run into a new conversation with no memory of its own work.
 *
 * What it cannot do, declared rather than faked:
 *  - permission is a POLICY, chosen when the process starts, so `respondAsk`
 *    can only ever be a no-op and no ask is ever raised.
 *  - nothing is reconfigurable mid-session: model and sandbox are start-time
 *    flags of a process that lives for one turn.
 *  - it signs in on its own, so its models are not a provider question.
 */
export const CODEX_CAPABILITIES: HarnessCapabilities = {
  approvals: 'policy',
  usage: 'tokens',
  models: 'builtin',
  sessionControls: { model: false, provider: false, mode: false, autoApprove: false, commands: false },
};

/** The provider name a Codex machine reports its models under. */
export const CODEX_PROVIDER = 'codex';

/**
 * Companion fences unattended work with the run's own worktree, which holds no
 * push credential: `Checkouts` supplies one per operation and never writes it
 * into the tree. That is the whole fence here.
 *
 * Claude Code additionally gets a `Bash(git push:*)` deny rule as a second
 * layer. Codex has no per-command deny on its command line: its equivalent is
 * an execpolicy `.rules` file, which is read from the operator's own CODEX_HOME
 * or from the repository being worked on. Companion will not edit the first or
 * commit into the second, so the second layer is absent rather than faked.
 */
const BYPASS_SANDBOX = '--dangerously-bypass-approvals-and-sandbox';

export interface CodexOptions {
  readonly runId: string;
  readonly cwd: string;
  readonly cliPath: string;
  /** `--model`; omitted lets Codex use the account default. */
  readonly model?: string | null;
}

export interface CodexHandlers {
  onEvent?(event: HarnessEvent): void;
  onTurnComplete?(payload: { turnId?: string }): void;
  onClose?(): void;
}

const TURN_TIMEOUT_MS = 30 * 60_000;

export class CodexHarness implements Harness {
  readonly capabilities = CODEX_CAPABILITIES;

  /** The process running the turn in flight; null between turns. */
  private proc: ChildProcess | null = null;
  private adapter: CodexAdapter;
  private stdoutTail = '';
  private stderrTail = '';
  private closed = false;
  private turns = 0;
  private threadId: string | null = null;
  private model: string | null;
  /**
   * What this run has emitted. Bounded so a long run cannot grow without limit;
   * the rollout file Codex writes is the complete record and is what a reaped
   * run reads.
   */
  private readonly recent: HarnessEvent[] = [];
  private static readonly RECENT_LIMIT = 2_000;

  /** Resolves when the turn in flight ends; the harness runs one at a time. */
  private inFlight: { turnId: string; done: () => void } | null = null;

  /**
   * Stable across restarts and derived from the run, so replayed and live
   * events number into one stream. Deliberately NOT the Codex thread id, which
   * does not exist until the first turn has spoken.
   */
  readonly sessionId: string;

  constructor(
    private readonly opts: CodexOptions,
    private readonly handlers: CodexHandlers,
  ) {
    this.sessionId = opts.runId;
    this.model = opts.model ?? null;
    this.adapter = this.newAdapter(0);
  }

  private newAdapter(seq: number): CodexAdapter {
    return new CodexAdapter(
      this.sessionId,
      {
        onEvent: (event) => this.record(event),
        onTurnEnd: (summary) => this.endTurn(summary),
        onThread: (threadId) => this.rememberThread(threadId),
      },
      seq,
    );
  }

  /**
   * Ready this run for turns.
   *
   * No process is started, because there is nothing to start between turns, so
   * this checks the one thing a caller can act on: that the CLI is there at all.
   * A refused sign-in surfaces on the turn it belongs to, where the error is
   * about that turn rather than about a session that never existed.
   */
  async connect(): Promise<void> {
    this.closed = false;
    try {
      await execFileP(this.opts.cliPath, ['--version'], { timeout: 15_000 });
    } catch (err) {
      throw new Error(`codex could not be started: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.threadId = readThread(this.opts.runId);
    // What this run already said, replayed before the new process speaks. A
    // resumed run has its whole transcript on disk and none of it in memory, so
    // without this the run detail page would come back blank; numbering
    // continues past it so nothing collides with a replayed event.
    const replayed = this.threadId ? readCodexThread(this.sessionId, this.threadId) : [];
    if (replayed.length > 0) {
      this.recent.length = 0;
      this.recent.push(...replayed.slice(-CodexHarness.RECENT_LIMIT));
      this.turns = replayed.filter((e) => e.type === 'user_prompt').length;
      this.adapter = this.newAdapter(replayed.length);
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
    this.proc = null;
    if (!proc) return;
    proc.stdin?.end();
    proc.kill('SIGTERM');
    setTimeout(() => proc.kill('SIGKILL'), 3_000).unref();
  }

  /**
   * Whether this run may still take a turn. Not "a process is running": between
   * turns there is deliberately nothing running, and a session that reported
   * itself shut at that moment would refuse every prompt after the first.
   */
  get isOpen(): boolean {
    return !this.closed;
  }

  async runTurn(args: RunTurnArgs): Promise<RunTurnResult> {
    if (this.closed) throw new Error(`codex session for ${this.opts.runId} is not running`);
    if (this.inFlight) throw new Error(`a turn is already running on ${this.opts.runId}`);
    if (args.model) this.model = args.model;

    const turnId = `${this.sessionId}:t${++this.turns}`;
    this.adapter.beginTurn(turnId, args.prompt);

    // `-` reads the prompt from stdin. Passing it as an argument instead would
    // let a prompt that happens to start with a dash be parsed as a flag, and
    // caps it at the platform's argument length.
    const argv = [
      'exec',
      ...(this.threadId ? ['resume'] : []),
      '--json',
      BYPASS_SANDBOX,
      // A run's working directory is a worktree, but a probe's is scratch space
      // and a repo-less run is legitimate; neither is Codex's business.
      '--skip-git-repo-check',
      ...(this.model ? ['--model', this.model] : []),
      ...(this.threadId ? [this.threadId] : []),
      '-',
    ];
    const proc = spawn(this.opts.cliPath, argv, {
      // `codex exec resume` takes no --cd, so the working directory is the
      // process's own and is the one thing both forms agree on.
      cwd: this.opts.cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    this.stdoutTail = '';
    this.stderrTail = '';

    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => this.onStdout(chunk));
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4_000);
    });
    // A stream or child that emits `error` with nothing listening throws on the
    // process itself, so a missing binary would take the daemon down with it.
    const note = (err: Error): void => {
      this.stderrTail = `${this.stderrTail}${err.message}`.slice(-4_000);
    };
    proc.on('error', note);
    proc.stdin?.on('error', note);

    // A turn that has not finished in half an hour is not going to.
    const timer = setTimeout(() => void this.abortTurn(), TURN_TIMEOUT_MS);
    timer.unref();
    this.inFlight = {
      turnId,
      done: () => {
        clearTimeout(timer);
        this.handlers.onTurnComplete?.({ turnId });
      },
    };

    proc.once('exit', (code, signal) => {
      if (this.proc === proc) this.proc = null;
      if (code !== 0 && !this.closed) {
        log.warn('codex exited', { runId: this.opts.runId, code, signal, stderr: this.stderrTail.slice(-500) });
      }
      // The stream normally settles the turn with `turn.completed`. A process
      // that died before saying so must not leave its caller waiting.
      this.settleTurn();
    });

    proc.stdin?.write(args.prompt);
    proc.stdin?.end();
    return { turnId };
  }

  /**
   * Stop the turn in flight. The session survives: the thread is on disk and the
   * next prompt resumes it, so unlike Claude Code this is a genuine interrupt
   * rather than the end of the run.
   */
  async abortTurn(): Promise<void> {
    this.settleTurn();
    this.terminate();
  }

  /**
   * The models this installation can run, shaped so the one catalog reader
   * understands it. `codex` is named as the provider because a machine's models
   * have to hang off something; that it is not a credential the operator
   * supplies is what `capabilities.models` says.
   */
  async sessionInfo(): Promise<unknown> {
    const models = [...codexModels(), ...(this.model ? [this.model] : [])];
    return {
      activeProvider: CODEX_PROVIDER,
      readyProviders: [CODEX_PROVIDER],
      providers: [
        {
          name: CODEX_PROVIDER,
          enabled: true,
          models: [...new Set(models)].map((id) => ({ id, contextWindow: null })),
        },
      ],
      tools: [],
      permissionMode: BYPASS_SANDBOX,
      slashCommands: [],
    };
  }

  /** No prompt is ever raised, so there is nothing to answer. */
  async respondAsk(_requestId: string, _response: AskResponse): Promise<void> {
    throw new Error('codex settles permission by policy and raises no approval');
  }

  /**
   * A live run answers from memory, which `connect` seeded with whatever was
   * already on disk. Once the run is gone the rollout file is the record.
   */
  async loadHistory(_workspaceId: string, before: number | null, limit: number): Promise<HistorySegment> {
    const events = this.isOpen ? this.recent : readCodexRunHistoryEvents(this.opts.runId);
    return segment(events, before, limit);
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

  /**
   * The id every later turn resumes. Written through immediately rather than at
   * the end of the turn: a daemon that stops mid-turn would otherwise leave the
   * run pointing at no thread and start a fresh conversation on resume.
   */
  private rememberThread(threadId: string): void {
    if (this.threadId === threadId) return;
    this.threadId = threadId;
    writeThread(this.opts.runId, threadId);
  }

  private record(event: HarnessEvent): void {
    this.recent.push(event);
    if (this.recent.length > CodexHarness.RECENT_LIMIT) {
      this.recent.splice(0, this.recent.length - CodexHarness.RECENT_LIMIT);
    }
    // A consumer that throws must not stop the read loop.
    try {
      this.handlers.onEvent?.(event);
    } catch {
      // isolated on purpose
    }
  }

  private endTurn(_summary: CodexTurnSummary): void {
    this.settleTurn();
  }

  private settleTurn(): void {
    const turn = this.inFlight;
    this.inFlight = null;
    turn?.done();
  }
}

// ---------- on-disk state ----------------------------------------------------

/**
 * Where this run's Codex thread id is parked.
 *
 * It shares the per-run file directory with moxxy's explicit configs because it
 * is the same kind of thing (something a harness needs in order to start this
 * run again) and therefore wants the same retention: storage cleanup already
 * sweeps this directory against the run's own lease.
 */
function threadFile(runId: string): string {
  return join(paths.runConfigs(), `${runId}.json`);
}

function readThread(runId: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(threadFile(runId), 'utf8'));
    const id = (parsed as { codexThreadId?: unknown })?.codexThreadId;
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

function writeThread(runId: string, threadId: string): void {
  try {
    mkdirSync(paths.runConfigs(), { recursive: true });
    writeFileSync(threadFile(runId), JSON.stringify({ codexThreadId: threadId }), { mode: 0o600 });
  } catch (err) {
    // Losing this costs continuity on the next resume, not this turn.
    log.warn('could not record codex thread', { runId, err: String(err) });
  }
}

/** Codex's own config root; `CODEX_HOME` moves it, auth included. */
function configDir(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
}

/**
 * The models this installation can run, read from the cache Codex maintains.
 *
 * Deliberately not a list in this repo. Codex's model ids are versioned
 * (`gpt-5.6-sol`, `gpt-5.5`) with no stable aliases to pin to, so a hard-coded
 * list would start going stale on the next Codex release and would describe the
 * models this build was written against rather than the ones the machine can
 * actually reach.
 */
export function codexModels(): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(configDir(), 'models_cache.json'), 'utf8'));
    const models = (parsed as { models?: unknown }).models;
    if (!Array.isArray(models)) return [];
    return models
      .map((m) => (m as { slug?: unknown })?.slug)
      .filter((slug): slug is string => typeof slug === 'string' && slug.length > 0);
  } catch {
    return [];
  }
}

/**
 * The rollout file Codex wrote for a thread.
 *
 * Located by scanning newest first rather than by reproducing the name: the
 * date-partitioned path and the timestamp in the filename are Codex's rules,
 * not ours, and a change to either leaves this working.
 */
export function rolloutFile(threadId: string): string | null {
  const root = join(configDir(), 'sessions');
  const suffix = `-${threadId}.jsonl`;
  const walk = (dir: string, depth: number): string | null => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return null;
    }
    if (depth === 0) {
      const hit = entries.find((name) => name.endsWith(suffix));
      return hit ? join(dir, hit) : null;
    }
    // Newest partition first: the thread being resumed is almost always recent.
    for (const name of [...entries].sort().reverse()) {
      const found = walk(join(dir, name), depth - 1);
      if (found) return found;
    }
    return null;
  };
  // sessions/<year>/<month>/<day>/rollout-<timestamp>-<threadId>.jsonl
  return existsSync(root) ? walk(root, 3) : null;
}

/** A thread's transcript, read back from its rollout file. */
export function readCodexThread(sessionId: string, threadId: string): HarnessEvent[] {
  const file = rolloutFile(threadId);
  if (!file) return [];
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const records: unknown[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // tolerate corruption: one bad line must not hide the transcript
    }
  }
  return adaptRollout(sessionId, records);
}

function readCodexRunHistoryEvents(runId: string): HarnessEvent[] {
  const threadId = readThread(runId);
  return threadId ? readCodexThread(runId, threadId) : [];
}

/** A reaped run's transcript: whatever Codex kept for the thread it was on. */
export function readCodexRunHistory(runId: string, before: number | null, limit: number): HistorySegment {
  return segment(readCodexRunHistoryEvents(runId), before, limit);
}

function segment(events: readonly HarnessEvent[], before: number | null, limit: number): HistorySegment {
  const end = before === null ? events.length : Math.min(before, events.length);
  const start = Math.max(0, end - limit);
  return { events: events.slice(start, end), prevCursor: start > 0 ? start : null };
}

// ---------- detection --------------------------------------------------------

export interface CodexCli {
  readonly path: string;
  readonly version: string;
  /** `codex login status` said so. Costs no turn and no API call. */
  readonly loggedIn: boolean;
}

/** Presence and readiness of the `codex` CLI, without spending a turn. */
export async function detectCodexCli(cliPath = 'codex'): Promise<CodexCli | null> {
  let version: string;
  try {
    const { stdout } = await execFileP(cliPath, ['--version'], { timeout: 15_000 });
    // `codex --version` prints `codex-cli 0.146.0`.
    version = stdout.trim().split(/\s+/).pop() ?? '';
    if (!/^\d+\.\d+/.test(version)) return null;
  } catch {
    return null;
  }
  let loggedIn = false;
  try {
    const { stdout } = await execFileP(cliPath, ['login', 'status'], { timeout: 20_000 });
    // Matched on the negative: the signed-in answer names the account type
    // ("Logged in using ChatGPT"), and both answers contain "logged in".
    loggedIn = !/not logged in/i.test(stdout);
  } catch {
    loggedIn = false;
  }
  return { path: cliPath, version, loggedIn };
}
