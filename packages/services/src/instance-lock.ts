import { hostname } from 'node:os';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { companionHome } from './config.js';
import { log } from './lib/log.js';

interface LockFile {
  readonly pid: number;
  readonly host: string;
  readonly startedAt: number;
  heartbeatAt: number;
}

const FILE = (): string => join(companionHome(), 'instance.lock');
const BEAT_MS = 15_000;
/** Four missed beats. Long enough to survive a stalled process, short enough
 *  that a crashed node on a shared volume does not block failover for minutes. */
const STALE_MS = 60_000;

/**
 * One daemon per COMPANION_HOME.
 *
 * Companion is a single-node appliance by design, and the reason is on disk, not
 * in the database: the home holds git clones, worktrees, scratch space, run
 * configs and the isolated moxxy home. Two daemons sharing it would both run
 * every scheduled job, both sync the same repositories, and both check out the
 * same worktrees. SQLite's WAL would survive that; Companion's invariants would
 * not, and the damage would be silent.
 *
 * So make it loud. A second daemon refuses to start rather than corrupting
 * state, which turns "someone scaled the deployment to 2 replicas" from a
 * mystery into an error message.
 */
export class InstanceLock {
  private timer: NodeJS.Timeout | null = null;

  /**
   * How long to wait for a predecessor to stop beating before giving up. The
   * default covers the staleness window plus one beat; tests shorten it, and a
   * deployment that wants to fail fast can too.
   */
  constructor(private readonly waitMs: number = STALE_MS + BEAT_MS) {}

  /**
   * Take the lock, waiting out a predecessor that has stopped beating.
   *
   * Refusing outright was wrong for the deployment everyone actually does. A
   * rolling redeploy starts the new container before the old one's heartbeat has
   * aged out, and across containers neither the pid nor the hostname means
   * anything: the daemon is pid 1 in every one of them, and the recorded host is
   * a container id that no longer exists. So an ordinary redeploy hit "another
   * daemon is already using /data" and the deployment failed.
   *
   * Waiting keeps the invariant that matters. Two daemons must never run against
   * one home, and a genuinely live one keeps writing its heartbeat, so it is
   * still refused at the end of the window. What changes is that a dead
   * predecessor costs a pause instead of a failed boot.
   */
  async acquire(): Promise<void> {
    const deadline = Date.now() + this.waitMs;
    let announced = false;
    for (;;) {
      const existing = this.read();
      if (!existing || this.isStale(existing)) {
        if (existing) {
          log.warn(`taking over ${FILE()} from a dead daemon (pid ${existing.pid} on ${existing.host})`);
        }
        break;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `another Companion daemon is already using ${companionHome()} ` +
            `(pid ${existing.pid} on ${existing.host}), still beating after ` +
            `${Math.round(this.waitMs / 1000)}s.\n` +
            `Companion is single-node: one daemon per data directory. If you are scaling ` +
            `replicas, run active/passive instead, or give each instance its own COMPANION_HOME.`,
        );
      }
      if (!announced) {
        announced = true;
        log.warn(
          `waiting for the daemon holding ${companionHome()} (pid ${existing.pid} on ${existing.host}) ` +
            `to release it or stop beating; normal during a redeploy`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    this.write();
    this.timer = setInterval(() => this.write(), BEAT_MS);
    this.timer.unref();
  }

  release(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      const current = this.read();
      // Only remove OUR lock: a takeover race must not delete the winner's.
      if (current && current.pid === process.pid && current.host === hostname()) unlinkSync(FILE());
    } catch {
      // A missing or unreadable lock on shutdown is not worth a failure.
    }
  }

  private write(): void {
    const now = Date.now();
    const existing = this.read();
    const lock: LockFile = {
      pid: process.pid,
      host: hostname(),
      startedAt: existing?.pid === process.pid ? existing.startedAt : now,
      heartbeatAt: now,
    };
    writeFileSync(FILE(), JSON.stringify(lock), { mode: 0o600 });
  }

  private read(): LockFile | null {
    if (!existsSync(FILE())) return null;
    try {
      const parsed = JSON.parse(readFileSync(FILE(), 'utf8')) as LockFile;
      return typeof parsed.pid === 'number' && typeof parsed.heartbeatAt === 'number' ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * On THIS host a dead pid is decisive, so a supervisor restarting a killed
   * daemon takes over immediately instead of waiting out the heartbeat. Across
   * hosts (a shared volume) the pid means nothing, so only the heartbeat counts.
   */
  private isStale(lock: LockFile): boolean {
    if (lock.host === hostname()) {
      if (lock.pid === process.pid) return true;
      try {
        process.kill(lock.pid, 0);
        return false;
      } catch {
        return true;
      }
    }
    return Date.now() - lock.heartbeatAt > STALE_MS;
  }
}
