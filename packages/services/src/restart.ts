import { spawn } from 'node:child_process';
import { log } from './lib/log.js';

/**
 * Restarting the daemon, which is the only way a module that arrived after boot
 * becomes a loaded module: the external scan runs once, at startup.
 *
 * Exiting is not the same as restarting, and which one to do depends entirely on
 * how Companion was started:
 *
 * - Under a container, pm2 or a systemd unit, something is watching the process
 *   and will start it again. Exiting IS the restart, and spawning a replacement
 *   would be worse than useless: in a container the daemon is pid 1, so the
 *   whole container tears down and takes any child with it.
 * - Under a bare `npx @moxxy/companion` there is nothing watching. The CLI
 *   imports the daemon into its own process, so there is not even a parent left
 *   to notice. Exiting ends Companion until a human starts it again.
 *
 * So the unsupervised case starts its own successor first. The handover is the
 * one `InstanceLock` already covers: the successor waits for the predecessor to
 * release `$COMPANION_HOME` (which happens at the very end of its shutdown,
 * after the HTTP port is closed) instead of racing it for the port.
 */

/** What is watching this process, or null when nothing identifiable is. */
export type Supervisor = 'container' | 'pm2' | 'systemd' | null;

export interface RestartPlan {
  readonly supervisor: Supervisor;
  /** true = nothing will bring this process back, so it must start its own successor. */
  readonly reexec: boolean;
  /** The successor's argv, empty when a supervisor is doing the restarting. */
  readonly command: readonly string[];
}

/** The parts of `process` this decision reads, so both branches are testable. */
export interface ProcessFacts {
  readonly pid: number;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly execPath: string;
  readonly execArgv: readonly string[];
  readonly argv: readonly string[];
}

/**
 * `pm_id` is set by pm2 in every process it manages; `INVOCATION_ID` by systemd
 * (v232+) in every unit it starts. Pid 1 is checked last because a pm2 or
 * systemd process can also be pid 1 inside a container, and the more specific
 * name is the more useful thing to tell an operator.
 */
export function detectSupervisor(env: ProcessFacts['env'], pid: number): Supervisor {
  if (env.pm_id !== undefined) return 'pm2';
  if (env.INVOCATION_ID !== undefined) return 'systemd';
  if (pid === 1) return 'container';
  return null;
}

/**
 * `execArgv` as well as `argv`: node flags (`--enable-source-maps`, a heap
 * limit) are not in argv, and a successor that quietly drops them is a
 * different process than the one the operator started.
 */
export function planRestart(proc: ProcessFacts = process): RestartPlan {
  const supervisor = detectSupervisor(proc.env, proc.pid);
  if (supervisor !== null) return { supervisor, reexec: false, command: [] };
  return {
    supervisor,
    reexec: true,
    command: [proc.execPath, ...proc.execArgv, ...proc.argv.slice(1)],
  };
}

/**
 * Start the successor if this process needs one, then exit through the normal
 * SIGTERM path so every module's `onDisable` runs and the database closes
 * cleanly. Throws BEFORE scheduling the exit if the successor cannot be
 * started, because shutting down with nothing to replace us is the one outcome
 * worth refusing.
 */
export function restartDaemon(delayMs = 300): RestartPlan {
  const plan = planRestart();
  if (plan.reexec) {
    const [command, ...args] = plan.command as string[];
    // Detached so the successor outlives this process group, inheriting stdio so
    // an operator watching a terminal keeps seeing Companion's output.
    const child = spawn(command!, args, { detached: true, stdio: 'inherit' });
    if (child.pid === undefined) {
      throw new Error('could not start a replacement process, so Companion has not been stopped');
    }
    child.unref();
    log.warn(`restarting: started replacement pid ${child.pid}, this process is stopping`);
  } else {
    log.warn(`restarting: exiting for ${plan.supervisor} to start Companion again`);
  }
  // Let the response flush before the shutdown starts tearing down.
  setTimeout(() => process.kill(process.pid, 'SIGTERM'), delayMs).unref();
  return plan;
}
