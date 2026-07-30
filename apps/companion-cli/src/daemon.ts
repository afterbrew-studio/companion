import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

/**
 * The lock file the daemon writes for itself (see InstanceLock in
 * @moxxy/companion-services). The CLI only ever reads it: it is already the one
 * record of "a daemon owns this home", written by every way of starting one
 * (npx, pm2, Docker, a source build), so a second pid file of our own would be
 * a second answer to a question that already has one.
 */
interface LockFile {
  readonly pid: number;
  readonly host: string;
  readonly heartbeatAt: number;
}

/** Where a backgrounded daemon's output goes, since nobody is watching a terminal. */
const LOG_FILE = 'companiond.log';
/** Rolled at this size, keeping one previous file: an unattended daemon must
 *  not fill the disk that holds its own database. */
const MAX_LOG_BYTES = 5 * 1024 * 1024;
/** The daemon force-exits 6s into its own shutdown, so this outlasts it. */
const STOP_TIMEOUT_MS = 10_000;

export function daemonLog(home: string): string {
  return join(home, LOG_FILE);
}

function readLock(home: string): LockFile | null {
  const file = join(home, 'instance.lock');
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as LockFile;
    return typeof parsed.pid === 'number' && typeof parsed.host === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * EPERM means the pid exists and belongs to someone else, which is still
 * running. Anything else means it is gone.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The pid of a daemon serving this home from this machine, or null.
 *
 * The same rule the daemon applies to its own lock: on this host a live pid is
 * decisive and the heartbeat is not consulted, because a stopped-and-restarted
 * machine leaves a lock whose pid is simply gone. A lock from another host
 * (a shared volume) says nothing about a process here, so it is not ours to
 * read as running.
 */
export function runningPid(home: string): number | null {
  const lock = readLock(home);
  if (!lock || lock.host !== hostname()) return null;
  return alive(lock.pid) ? lock.pid : null;
}

export interface Detached {
  readonly pid: number;
  readonly log: string;
  /** Resolves if the daemon exits, which during startup means it failed. */
  readonly exited: Promise<void>;
}

/**
 * Start the daemon as its own process group, surviving this CLI and the
 * terminal that ran it.
 *
 * `detached` is what makes it a daemon rather than a child: without it the
 * process stays in the CLI's group and a Ctrl+C aimed at something else, or
 * simply closing the terminal, takes Companion down with it.
 */
export function startDetached(server: string, home: string): Detached {
  const log = daemonLog(home);
  rollLog(log);
  const out = openSync(log, 'a');
  const child = spawn(process.execPath, [server], {
    cwd: home,
    detached: true,
    stdio: ['ignore', out, out],
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  // The child holds its own descriptor for the log from here on.
  closeSync(out);
  child.unref();
  if (child.pid === undefined) throw new Error(`Could not start the Companion daemon. Check ${log}.`);
  return { pid: child.pid, log, exited };
}

/**
 * Wait for THIS daemon to be serving, rather than for the port to answer.
 *
 * A 200 from `/healthz` only proves something is listening there, and the case
 * where that distinction matters is exactly the one a detached start hits: the
 * address is already taken, our daemon dies of EADDRINUSE, and the process that
 * took it answers the health check on its behalf. So readiness is two facts —
 * the home is locked by the pid we started, which the daemon writes before it
 * binds, and the address answers.
 */
export async function waitUntilServing(
  daemon: Detached,
  home: string,
  baseUrl: string,
  timeoutMs: number,
): Promise<'ready' | 'timeout' | 'exited'> {
  let exited = false;
  void daemon.exited.then(() => {
    exited = true;
  });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited) return 'exited';
    if (runningPid(home) === daemon.pid && (await isServing(baseUrl))) return 'ready';
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return exited ? 'exited' : 'timeout';
}

function rollLog(file: string): void {
  try {
    if (statSync(file).size < MAX_LOG_BYTES) return;
    renameSync(file, `${file}.1`);
  } catch {
    // No log yet, or a directory we cannot rotate in: the append below decides.
  }
}

export function tailLog(file: string, lines = 20): string {
  try {
    return readFileSync(file, 'utf8').split('\n').slice(-lines).join('\n').trim();
  } catch {
    return '(no output)';
  }
}

/**
 * Stop the daemon owning this home.
 *
 * SIGTERM is what the daemon's own handler waits for, so the graceful path
 * closes the port, the database and the module kernel in order. SIGKILL is the
 * fallback for a shutdown that hangs past its own force-exit; it leaves the
 * lock file behind, which the next boot reads as a dead pid and takes over.
 */
export async function stopDaemon(home: string, baseUrl: string): Promise<void> {
  const lock = readLock(home);
  if (lock && lock.host !== hostname()) {
    throw new Error(
      `The daemon using ${home} runs on ${lock.host} (pid ${lock.pid}), not on this machine. Stop it there.`,
    );
  }
  const pid = lock && alive(lock.pid) ? lock.pid : null;
  if (pid === null) {
    if (await isServing(baseUrl)) {
      throw new Error(
        `Nothing holds ${home}, but something is answering at ${baseUrl}.\n` +
          `If that is Companion, stop it with the --home it was started with.`,
      );
    }
    process.stdout.write(`Companion is not running (${home}).\n`);
    return;
  }

  process.stdout.write(`Stopping Companion (pid ${pid})…\n`);
  if (!signal(pid, 'SIGTERM')) {
    process.stdout.write('Already stopped.\n');
    return;
  }
  if (await waitForExit(pid, STOP_TIMEOUT_MS)) {
    process.stdout.write('Stopped.\n');
    return;
  }
  process.stderr.write(`Still running after ${STOP_TIMEOUT_MS / 1000}s, sending SIGKILL.\n`);
  signal(pid, 'SIGKILL');
  if (!(await waitForExit(pid, 3_000))) throw new Error(`Could not stop pid ${pid}.`);
  process.stdout.write('Stopped (killed).\n');
}

/** False when the process was already gone; throws when it is not ours to signal. */
function signal(pid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(pid, sig);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') {
      throw new Error(`Companion (pid ${pid}) runs as another user. Stop it as that user, or with sudo.`);
    }
    throw err;
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return !alive(pid);
}

async function isServing(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(1_500) });
    return response.ok;
  } catch {
    return false;
  }
}
