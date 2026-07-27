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

  /** Throws when another live daemon holds this home. */
  acquire(): void {
    const existing = this.read();
    if (existing && !this.isStale(existing)) {
      throw new Error(
        `another Companion daemon is already using ${companionHome()} ` +
          `(pid ${existing.pid} on ${existing.host}).\n` +
          `Companion is single-node: one daemon per data directory. If you are scaling ` +
          `replicas, run active/passive instead, or give each instance its own COMPANION_HOME.`,
      );
    }
    if (existing) {
      log.warn(`taking over ${FILE()} from a dead daemon (pid ${existing.pid} on ${existing.host})`);
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
