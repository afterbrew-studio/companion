import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { safeToolEnvironment } from './tool-exec.js';

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
  /** Run inside a locked-down ephemeral container instead of on the host. */
  readonly sandbox?: {
    readonly image: string;
    /** `none` (default) or an operator-created, egress-filtered Docker network. */
    readonly network: string;
  };
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
const activeSandboxContainers = new Set<string>();

export function killAllCommands(): void {
  for (const pid of [...activeCommandPids]) killTree(pid);
  for (const name of [...activeSandboxContainers]) void removeSandboxContainer(name);
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
  const sandbox = opts.sandbox;
  const sandboxName = sandbox ? `companion-pipeline-${randomUUID()}` : null;
  const sandboxArgs = sandbox
    ? pipelineSandboxArgs(cwd, command, sandbox, opts.env ?? {}, sandboxName!)
    : null;
  return new Promise<VerifyOutcome>((resolve) => {
    if (sandboxName) activeSandboxContainers.add(sandboxName);
    const child = sandbox
      ? spawn('docker', sandboxArgs!, {
          cwd,
          shell: false,
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: dockerClientEnvironment(opts.env ?? {}),
        })
      : spawn(command, {
      cwd,
      shell: true,
      // Puts the shell in its own process group so the timeout can signal the
      // whole tree. Without it there is no group to kill and the real work,
      // which is always a grandchild, survives as an orphan.
      detached: true,
      // A verify command must never wait on a prompt nobody can answer.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: safeToolEnvironment(process.env, { CI: '1', ...opts.env }),
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

    const terminate = (): void => {
      killTree(child.pid);
      // Killing the Docker client does not guarantee that the daemon stops the
      // container. Remove by an unguessable name as well, so a timed-out command
      // cannot keep running with a publishing credential in its environment.
      if (sandboxName) void removeSandboxContainer(sandboxName);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      // The shell is the child; the actual build is its grandchild, so killing
      // the group is what stops the work rather than orphaning it. Negative pid
      // addresses the group, which `detached` above is what creates.
      terminate();
    }, timeoutMs);
    timer.unref();

    const abort = (): void => terminate();
    if (opts.signal?.aborted) abort();
    else opts.signal?.addEventListener('abort', abort, { once: true });

    const finish = (exitCode: number | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', abort);
      if (child.pid !== undefined) activeCommandPids.delete(child.pid);
      void (async () => {
        if (sandboxName) {
          await removeSandboxContainer(sandboxName);
          activeSandboxContainers.delete(sandboxName);
        }
        resolve({
          exitCode,
          output: output.slice(-maxOutput).trimEnd(),
          timedOut,
          durationMs: Date.now() - started,
        });
      })();
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

const OCI_IMAGE = /^[a-zA-Z0-9][a-zA-Z0-9._/:-]{0,220}@sha256:[a-fA-F0-9]{64}$/;
const DOCKER_NETWORK = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

export function pipelineSandboxArgs(
  cwd: string,
  command: string,
  sandbox: NonNullable<ExecOptions['sandbox']>,
  overlay: Readonly<Record<string, string>>,
  containerName?: string,
): string[] {
  if (!OCI_IMAGE.test(sandbox.image)) {
    throw new Error('pipeline sandbox image must be an OCI reference pinned by a sha256 digest');
  }
  if (
    sandbox.network !== 'none'
    && (!DOCKER_NETWORK.test(sandbox.network) || ['host', 'bridge', 'default'].includes(sandbox.network))
  ) {
    throw new Error('pipeline sandbox network must be none or an operator-created restricted Docker network');
  }
  for (const key of Object.keys(overlay)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`invalid pipeline environment name: ${key}`);
  }
  const user = process.platform === 'win32' || !process.getuid || !process.getgid
    ? []
    : ['--user', `${process.getuid()}:${process.getgid()}`];
  return [
    'run',
    '--rm',
    ...(containerName ? ['--name', containerName] : []),
    '--pull',
    'never',
    '--init',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '256',
    '--memory',
    '2g',
    '--cpus',
    '2',
    '--network',
    sandbox.network,
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,size=536870912',
    '--volume',
    `${cwd}:/workspace:rw`,
    '--workdir',
    '/workspace',
    '--env',
    'CI=1',
    '--env',
    'HOME=/tmp',
    ...Object.keys(overlay).flatMap((key) => ['--env', key]),
    ...user,
    '--entrypoint',
    '/bin/sh',
    sandbox.image,
    '-lc',
    command,
  ];
}

function removeSandboxContainer(name: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn('docker', ['rm', '--force', name], {
      shell: false,
      stdio: 'ignore',
      env: dockerClientEnvironment({}),
    });
    child.once('error', () => resolve());
    child.once('close', () => resolve());
  });
}

/** The Docker client needs its own connection/config and the explicit overlay,
 * not every credential/config variable held by companiond. */
function dockerClientEnvironment(overlay: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const allowed = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'TMPDIR',
    'DOCKER_HOST',
    'DOCKER_CONTEXT',
    'DOCKER_CONFIG',
    'DOCKER_TLS_VERIFY',
    'DOCKER_CERT_PATH',
  ] as const;
  const env: NodeJS.ProcessEnv = { CI: '1', ...overlay };
  for (const key of allowed) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}
