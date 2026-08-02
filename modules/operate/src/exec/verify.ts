import { spawn } from 'node:child_process';

/** How much of a verify command's output is kept. Enough to see a failure, not a log dump. */
const MAX_OUTPUT = 8_000;
/** Default ceiling; a verify command that runs longer than this is not a verify command. */
export const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60_000;

export interface ExecOptions {
  readonly timeoutMs?: number;
  /** Cancels the whole local process group, including shell grandchildren. */
  readonly signal?: AbortSignal;
  /**
   * Extra environment for this invocation only, merged over the daemon's.
   *
   * This is the ONLY channel a credential may take: never `process.env`, never
   * the command text (a shell that stays alive puts its whole argv in `ps`),
   * never a file. The child's environment dies with the child, which is why the
   * process-group kill below is load-bearing rather than tidiness.
   */
  readonly env?: Readonly<Record<string, string>>;
  readonly maxOutput?: number;
  /**
   * Called with each chunk as it arrives, for callers that show progress rather
   * than only a result. The full output is still returned at the end; this is
   * additive, so a caller that ignores it behaves exactly as before.
   *
   * The chunk is RAW. Anything that persists or broadcasts it must scrub first,
   * and must do so across chunk boundaries: a credential can straddle two.
   */
  readonly onChunk?: (text: string) => void;
}

export interface VerifyOutcome {
  readonly exitCode: number | null;
  /** Combined stdout+stderr, tail-clipped. */
  readonly output: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

/**
 * SIGKILL a spawned command's entire process group. Both failure modes are
 * expected and neither is actionable: a spawn that never started has no pid,
 * and a group that already exited raises ESRCH.
 */
export function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

/** Graceful daemon shutdown must not leave detached verification shells behind. */
const activeCommandPids = new Set<number>();

export function killAllCommands(): void {
  for (const pid of [...activeCommandPids]) killTree(pid);
}

/**
 * Run a project's own verification command inside a prepared worktree.
 *
 * Through a shell on purpose: the value people put here is `pnpm -s typecheck &&
 * pnpm -s test`, and refusing shell syntax would mean refusing the thing they
 * actually run. That is not a new capability on this machine either way, because
 * the agent that just produced this diff had a shell in the same directory. The
 * command comes from repository configuration written by someone who may already
 * manage that repository, and it never comes from a request body.
 *
 * The TAIL is kept rather than the head. A failing build says what went wrong at
 * the end, after however many lines of progress output.
 */
export function runVerify(
  cwd: string,
  command: string,
  timeoutMs: number = DEFAULT_VERIFY_TIMEOUT_MS,
): Promise<VerifyOutcome> {
  return runCommand(cwd, command, { timeoutMs });
}

/**
 * The general form: `runVerify` plus a per-invocation environment overlay and a
 * caller-chosen output ceiling. Executable pipeline steps run through here.
 *
 * Everything runVerify's doc says about the shell applies unchanged. What is new
 * is `opts.env`, and the whole safety argument for it rests on the process group
 * being killed on timeout: an orphaned grandchild keeps the overlay alive in its
 * own environment for as long as it runs.
 */
export async function runCommand(
  cwd: string,
  command: string,
  opts: ExecOptions = {},
): Promise<VerifyOutcome> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  const maxOutput = opts.maxOutput ?? MAX_OUTPUT;
  const started = Date.now();
  return new Promise<VerifyOutcome>((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      // Puts the shell in its own process group so the timeout can signal the
      // whole tree. Without it there is no group to kill and the real work,
      // which is always a grandchild, survives as an orphan.
      detached: true,
      // A verify command must never wait on a prompt nobody can answer.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1', ...opts.env },
    });
    if (child.pid !== undefined) activeCommandPids.add(child.pid);

    let output = '';
    let timedOut = false;
    let finished = false;
    const append = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      output += text;
      if (output.length > maxOutput * 2) output = output.slice(-maxOutput);
      try {
        opts.onChunk?.(text);
      } catch {
        // A consumer that throws must not kill the command it is watching.
      }
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    const timer = setTimeout(() => {
      timedOut = true;
      // The shell is the child; the actual build is its grandchild, so killing
      // the group is what stops the work rather than orphaning it. Negative pid
      // addresses the group, which `detached` above is what creates.
      killTree(child.pid);
    }, timeoutMs);
    timer.unref();

    const abort = (): void => killTree(child.pid);
    if (opts.signal?.aborted) abort();
    else opts.signal?.addEventListener('abort', abort, { once: true });

    const finish = (exitCode: number | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abort);
      if (child.pid !== undefined) activeCommandPids.delete(child.pid);
      resolve({
        exitCode,
        output: output.slice(-maxOutput).trimEnd(),
        timedOut,
        durationMs: Date.now() - started,
      });
    };

    child.on('error', (err) => {
      // A missing binary is a verification failure with a readable reason, not
      // an exception for the caller to interpret.
      output += `\n${String(err.message)}`;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}
