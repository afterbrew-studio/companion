import { spawn } from 'node:child_process';
import type { AgentToolHealth, AgentToolProbe } from '@moxxy/companion-types';

/**
 * Running a developer tool on the machine that has it.
 *
 * This is the primitive under both sides of "my laptop has the CodeRabbit CLI":
 * companiond runs it in-process for its own machine, and the companion-runner
 * agent runs it for a remote one behind `POST /agent/exec`. One implementation,
 * so a review behaves the same wherever it lands. The difference between the
 * two is a network hop, not a second set of rules about environments, output
 * limits and how a cancelled tool is killed.
 */

/**
 * What a provider CLI is allowed to see of the process that started it.
 *
 * A tool is a separate trust boundary: it needs the machine user's own CLI
 * config and network settings, and nothing else. Passing the whole environment
 * would hand every provider binary Companion's GitHub token, its model provider
 * keys and its database path, which is exactly the leak an allow-list closes.
 */
const SAFE_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
] as const;

export const DEFAULT_MAX_STDOUT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_STDERR_BYTES = 512 * 1024;
const PROBE_TIMEOUT_MS = 15_000;

export function safeToolEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  overlay: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return { ...environment, ...overlay };
}

export interface ToolRunOptions {
  readonly cwd?: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Called per complete stdout line while the tool runs. */
  readonly onLine?: (line: string) => void;
  /** Raw stream chunks, for a caller that forwards them somewhere else. */
  readonly onChunk?: (stream: 'stdout' | 'stderr', chunk: string) => void;
  readonly maxStdout?: number;
  readonly maxStderr?: number;
  readonly env?: Readonly<Record<string, string>>;
}

export interface ToolRunResult {
  /** Which candidate ran; null when none of them is installed. */
  readonly binary: string | null;
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
  /** Nothing on PATH answered. Absence, never a tool defect. */
  readonly missing: boolean;
}

/** Nothing this machine could run answered: absence, not failure. */
export class ToolMissingError extends Error {
  constructor(readonly binaries: readonly string[]) {
    super(`none of ${binaries.join(', ')} is installed on this machine`);
    this.name = 'ToolMissingError';
  }
}

/**
 * Run the first of `binaries` that exists, with `args`.
 *
 * ENOENT walks to the next candidate; anything else is that tool failing and is
 * reported as such. The distinction is load-bearing upstream: absence is
 * eligible for another provider, a crash never is.
 */
export async function runTool(
  binaries: readonly string[],
  args: readonly string[],
  options: ToolRunOptions,
): Promise<ToolRunResult> {
  const started = Date.now();
  for (const binary of binaries) {
    const attempt = await runOne(binary, args, options, started);
    if (attempt !== null) return attempt;
  }
  return {
    binary: null,
    code: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    durationMs: Date.now() - started,
    missing: true,
  };
}

/** Resolves to null when the executable is not on PATH (try the next one). */
function runOne(
  binary: string,
  args: readonly string[],
  options: ToolRunOptions,
  started: number,
): Promise<ToolRunResult | null> {
  return new Promise((resolve, reject) => {
    const maxStdout = options.maxStdout ?? DEFAULT_MAX_STDOUT_BYTES;
    const maxStderr = options.maxStderr ?? DEFAULT_MAX_STDERR_BYTES;
    if (options.signal?.aborted) {
      reject(new Error('the command was cancelled'));
      return;
    }
    const child = spawn(binary, [...args], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      shell: false,
      // A CLI may start helpers. Give it its own process group so cancellation
      // cannot leave credential-bearing grandchildren running.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: safeToolEnvironment(process.env, options.env ?? {}),
    });
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let pending = '';
    let settled = false;
    let timedOut = false;
    let terminalError: Error | null = null;
    let forceKill: NodeJS.Timeout | null = null;

    const stop = (): void => {
      signalProcessTree(child, 'SIGTERM');
      forceKill ??= setTimeout(() => signalProcessTree(child, 'SIGKILL'), 5_000);
      forceKill.unref();
    };
    const finish = (work: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      work();
    };
    const terminate = (error: Error): void => {
      if (terminalError) return;
      terminalError = error;
      stop();
    };
    const abort = (): void => terminate(new Error('the command was cancelled'));
    const timer = setTimeout(() => {
      timedOut = true;
      // Not an error: a tool that ran out of time still produced output worth
      // reporting, and the caller decides what a timeout means for its own job.
      stop();
    }, options.timeoutMs);
    timer.unref();

    child.once('error', (error: NodeJS.ErrnoException) => {
      // Not installed under this name: the caller tries the next candidate.
      if (error.code === 'ENOENT') return finish(() => resolve(null));
      finish(() => reject(error));
    });
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > maxStdout) {
        terminate(new Error(`${binary} produced more than ${maxStdout} bytes of output`));
        return;
      }
      const text = chunk.toString('utf8');
      stdout += text;
      options.onChunk?.('stdout', text);
      if (!options.onLine) return;
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) options.onLine(line);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= maxStderr) return;
      const kept = chunk.subarray(0, maxStderr - stderrBytes);
      const text = kept.toString('utf8');
      stderr += text;
      stderrBytes += kept.byteLength;
      options.onChunk?.('stderr', text);
    });
    child.once('close', (code) => {
      if (forceKill) clearTimeout(forceKill);
      finish(() => {
        if (terminalError) reject(terminalError);
        else {
          resolve({
            binary,
            code: code ?? null,
            stdout,
            stderr,
            timedOut,
            durationMs: Date.now() - started,
            missing: false,
          });
        }
      });
    });
    options.signal?.addEventListener('abort', abort, { once: true });
    // Close the small race between the pre-spawn check and listener setup.
    if (options.signal?.aborted) abort();
  });
}

/**
 * Whether this machine has each tool, answered by asking it for its version.
 *
 * "On PATH" alone is not the question worth answering: a binary that cannot
 * even print its version will not complete a review either, and reporting it as
 * present sends work to a machine that cannot do it.
 */
export async function detectTools(probes: readonly AgentToolProbe[]): Promise<AgentToolHealth[]> {
  return Promise.all(probes.map((probe) => detectOne(probe)));
}

async function detectOne(probe: AgentToolProbe): Promise<AgentToolHealth> {
  try {
    const result = await runTool(probe.binaries, probe.versionArgs ?? ['--version'], {
      timeoutMs: PROBE_TIMEOUT_MS,
      maxStdout: 64 * 1024,
      maxStderr: 64 * 1024,
    });
    if (result.missing) {
      return { id: probe.id, binary: null, version: null, present: false, detail: null };
    }
    if (result.code !== 0) {
      return {
        id: probe.id,
        binary: result.binary,
        version: null,
        present: false,
        detail: firstLine(result.stderr || result.stdout) || `${result.binary} exited with ${result.code}`,
      };
    }
    return {
      id: probe.id,
      binary: result.binary,
      version: firstLine(result.stdout) || null,
      present: true,
      detail: null,
    };
  } catch (error) {
    return {
      id: probe.id,
      binary: null,
      version: null,
      present: false,
      detail: String(error instanceof Error ? error.message : error).slice(0, 300),
    };
  }
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim().slice(0, 200) ?? '';
}

function signalProcessTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (child.pid !== undefined && process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The group may already be gone; fall back to the direct child below.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Cancellation is idempotent and a process that already exited is done.
  }
}
