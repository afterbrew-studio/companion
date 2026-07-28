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

/**
 * The handover note, beside the lock. Deliberately a second file: the lock's
 * shape and its takeover race are load-bearing and this must not perturb either.
 */
interface HandoverFile {
  readonly requestedBy: string;
  readonly requestedAt: number;
  readonly yieldedBy: string | null;
  readonly yieldedAt: number;
}

const FILE = (): string => join(companionHome(), 'instance.lock');
const HANDOVER = (): string => join(companionHome(), 'instance.handover');
const BEAT_MS = 15_000;
/** Four missed beats. Long enough to survive a stalled process, short enough
 *  that a crashed node on a shared volume does not block failover for minutes. */
const STALE_MS = 60_000;
/** A request older than this is a leftover, not an ask. */
const HANDOVER_FRESH_MS = 45_000;
/**
 * How long after a handover nobody may ask for another.
 *
 * Without it, two daemons that both want the home take turns evicting each
 * other forever. With it the second eviction is refused, so the loser hits the
 * ordinary "already using" error and the situation stays diagnosable.
 */
const HANDOVER_COOLDOWN_MS = 5 * 60_000;

const handoverEnabled = (): boolean =>
  !['off', '0', 'false', 'no'].includes((process.env.COMPANION_LOCK_HANDOVER ?? '').trim().toLowerCase());

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
  private yielding = false;
  private onHandover: (() => void) | null = null;

  /**
   * What to run when a replacement asks for the home. The daemon passes its own
   * graceful shutdown, which releases the lock on the way out.
   *
   * Set after `acquire`, because the shutdown path needs the things boot builds.
   */
  handoverTo(shutdown: () => void): void {
    this.onHandover = shutdown;
  }

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
    this.refuseIfSuperseded();
    const deadline = Date.now() + this.waitMs;
    let announced = false;
    let asked = false;
    for (;;) {
      const existing = this.read();
      if (!existing || this.isStale(existing)) {
        if (existing) {
          log.warn(`taking over ${FILE()} from a dead daemon (pid ${existing.pid} on ${existing.host})`);
        }
        break;
      }
      if (!asked) {
        asked = true;
        this.requestHandover(existing);
      }
      if (Date.now() >= deadline) {
        // Reaching here means something refreshed the heartbeat for the whole
        // wait, so the holder is genuinely alive. The common cause is not two
        // replicas, it is a deployment that starts the replacement before
        // stopping the original and gates the stop on the replacement becoming
        // healthy, which with a single-node lock cannot resolve on its own.
        throw new Error(
          `another Companion daemon is already using ${companionHome()} ` +
            `(pid ${existing.pid} on ${existing.host}), and it kept heartbeating for ` +
            `${Math.round(this.waitMs / 1000)}s, so it is still running.\n` +
            `Companion is single-node: one daemon per data directory.\n` +
            `If this is a redeploy, the old container was not stopped first, and it ` +
            `did not answer the handover request either: either it predates handover ` +
            `or COMPANION_LOCK_HANDOVER is off. Use a stop-then-start (recreate) ` +
            `strategy rather than a rolling one, because the new instance cannot ` +
            `become healthy while the old one holds the data directory, and a ` +
            `rolling deploy waits for exactly that.\n` +
            `If you are scaling replicas, run active/passive instead, or give each ` +
            `instance its own COMPANION_HOME.`,
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
    this.clearHandover();
    this.timer = setInterval(() => this.beat(), BEAT_MS);
    this.timer.unref();
  }

  /**
   * Ask the holder to stand down, over the one channel two containers reliably
   * share: the data directory itself. Neither can see the other's processes, so
   * a rolling deploy is otherwise a true deadlock. The replacement cannot become
   * healthy until it has the home, and the orchestrator will not stop the
   * original until the replacement is healthy.
   */
  private requestHandover(holder: LockFile): void {
    if (!handoverEnabled()) return;
    const note = this.readHandover();
    if (note && Date.now() - note.yieldedAt < HANDOVER_COOLDOWN_MS) {
      log.warn(`not asking ${holder.host} to stand down: one handover already happened here recently`);
      return;
    }
    try {
      writeFileSync(
        HANDOVER(),
        JSON.stringify({ requestedBy: hostname(), requestedAt: Date.now(), yieldedBy: null, yieldedAt: 0 }),
        { mode: 0o600 },
      );
      log.warn(`asked the daemon on ${holder.host} to hand over ${companionHome()}`);
    } catch {
      // A home we cannot write to is about to fail the boot for better reasons.
    }
  }

  /**
   * A restart policy resurrects the container that just stood down, and it would
   * otherwise turn around and evict its own replacement. It recognises itself by
   * hostname, which Docker keeps across a restart of the same container.
   */
  private refuseIfSuperseded(): void {
    const note = this.readHandover();
    if (!note || note.yieldedBy !== hostname()) return;
    if (Date.now() - note.yieldedAt > HANDOVER_COOLDOWN_MS) return;
    throw new Error(
      `this container handed ${companionHome()} over to ${note.requestedBy} and was restarted.\n` +
        `It is superseded: stopping rather than evicting its own replacement.`,
    );
  }

  private beat(): void {
    this.write();
    if (this.yielding || !this.onHandover || !handoverEnabled()) return;
    const note = this.readHandover();
    if (!note || note.requestedBy === hostname()) return;
    if (Date.now() - note.requestedAt > HANDOVER_FRESH_MS) return;
    this.yielding = true;
    log.warn(`${note.requestedBy} asked for ${companionHome()}; shutting down so it can take over`);
    try {
      writeFileSync(
        HANDOVER(),
        JSON.stringify({ ...note, yieldedBy: hostname(), yieldedAt: Date.now() }),
        { mode: 0o600 },
      );
    } catch {
      // Recording it is best effort; standing down is not.
    }
    this.onHandover();
  }

  private readHandover(): HandoverFile | null {
    if (!existsSync(HANDOVER())) return null;
    try {
      const parsed = JSON.parse(readFileSync(HANDOVER(), 'utf8')) as HandoverFile;
      return typeof parsed.requestedBy === 'string' && typeof parsed.requestedAt === 'number' ? parsed : null;
    } catch {
      return null;
    }
  }

  /** Keep a yield on record for the cooldown; drop a request we have satisfied. */
  private clearHandover(): void {
    const note = this.readHandover();
    if (!note || note.yieldedBy !== null) return;
    try {
      unlinkSync(HANDOVER());
    } catch {
      // Only a leftover request; the freshness window retires it anyway.
    }
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
