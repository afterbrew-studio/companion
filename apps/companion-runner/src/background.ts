import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../../companiond/src/config.js';

/**
 * Background service mode: `companion-runner --background` re-execs the agent
 * detached from the terminal with stdout/stderr appended to `<home>/runner.log`.
 * The server process (foreground or detached) records its pid in
 * `<home>/runner.pid`, so `stop` and `status` work either way. No OS service
 * manager involved — survives the shell, not a reboot.
 */

const pidFile = (): string => join(paths.root(), 'runner.pid');
export const logFile = (): string => join(paths.root(), 'runner.log');

/** Called by the server process on boot; removed again on shutdown. */
export function writePidFile(): void {
  mkdirSync(paths.root(), { recursive: true });
  writeFileSync(pidFile(), `${process.pid}\n`);
}

export function removePidFile(): void {
  try {
    rmSync(pidFile());
  } catch {
    /* already gone */
  }
}

/** Pid of a live runner from the pidfile; clears a stale file. */
export function runningPid(): number | null {
  let pid: number;
  try {
    pid = Number(readFileSync(pidFile(), 'utf8').trim());
  } catch {
    return null;
  }
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!isAlive(pid)) {
    removePidFile();
    return null;
  }
  return pid;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = exists but owned by someone else — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** `--background`: spawn ourselves detached and report where the logs went. */
export function startBackground(): void {
  const existing = runningPid();
  if (existing) {
    process.stdout.write(`companion-runner is already running (pid ${existing}) — logs: ${logFile()}\n`);
    return;
  }
  mkdirSync(paths.root(), { recursive: true });
  const out = openSync(logFile(), 'a');
  const args = process.argv.slice(2).filter((a) => a !== '--background' && a !== '-b');
  const child = spawn(process.execPath, [process.argv[1] ?? '', ...args], {
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
  });
  child.unref();
  // The child rewrites this on boot; writing it here just makes
  // `status` truthful in the gap.
  if (child.pid) writeFileSync(pidFile(), `${child.pid}\n`);
  process.stdout.write(
    `companion-runner started in the background (pid ${child.pid})\n` +
      `  logs:   ${logFile()}\n` +
      `  status: companion-runner status\n` +
      `  stop:   companion-runner stop\n`,
  );
}

/** `stop`: SIGTERM the recorded pid and wait for it to exit. */
export async function stopBackground(): Promise<number> {
  const pid = runningPid();
  if (!pid) {
    process.stdout.write('companion-runner is not running.\n');
    return 0;
  }
  process.kill(pid, 'SIGTERM');
  // The agent force-exits 6s after SIGTERM; give it a little longer.
  for (let waited = 0; waited < 8_000; waited += 200) {
    if (!isAlive(pid)) {
      removePidFile();
      process.stdout.write(`stopped (pid ${pid}).\n`);
      return 0;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  process.stdout.write(`still running after SIGTERM (pid ${pid}) — kill it with: kill -9 ${pid}\n`);
  return 1;
}

/** `status`: report the recorded pid, if any. */
export function statusBackground(): void {
  const pid = runningPid();
  if (pid) {
    process.stdout.write(`companion-runner is running (pid ${pid}) — logs: ${logFile()}\n`);
  } else {
    process.stdout.write('companion-runner is not running.\n');
  }
}
