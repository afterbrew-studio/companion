import { spawn } from 'node:child_process';

/** How much of the command's output is kept. Enough to see a failure, not a log dump. */
const MAX_OUTPUT = 8_000;
/** Default ceiling; a verify command that runs longer than this is not a verify command. */
export const DEFAULT_VERIFY_TIMEOUT_MS = 10 * 60_000;

export interface VerifyOutcome {
  readonly exitCode: number | null;
  /** Combined stdout+stderr, tail-clipped. */
  readonly output: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
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
export async function runVerify(
  cwd: string,
  command: string,
  timeoutMs: number = DEFAULT_VERIFY_TIMEOUT_MS,
): Promise<VerifyOutcome> {
  const started = Date.now();
  return new Promise<VerifyOutcome>((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      // A verify command must never wait on a prompt nobody can answer.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1' },
    });

    let output = '';
    let timedOut = false;
    const append = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
      if (output.length > MAX_OUTPUT * 2) output = output.slice(-MAX_OUTPUT);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    const timer = setTimeout(() => {
      timedOut = true;
      // The shell is the child; the actual build is its grandchild, so killing
      // the group is what stops the work rather than orphaning it.
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref();

    const finish = (exitCode: number | null): void => {
      clearTimeout(timer);
      resolve({
        exitCode,
        output: output.slice(-MAX_OUTPUT).trimEnd(),
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
