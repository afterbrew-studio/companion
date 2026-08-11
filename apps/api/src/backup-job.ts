import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Database, type Logger } from '@moxxy/companion-services';

const PREFIX = 'companion-';
const SUFFIX = '.db';
export const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface ScheduledBackupOptions {
  readonly dbPath: string;
  readonly dir: string;
  /** Snapshots to retain; older ones are pruned after each run. */
  readonly keep: number;
  readonly log: Logger;
  /** Test hook; production runs daily. */
  readonly everyMs?: number;
}

function snapshotsIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  // ISO stamps sort lexicographically, so a plain sort is oldest → newest.
  return readdirSync(dir)
    .filter((f) => f.startsWith(PREFIX) && f.endsWith(SUFFIX))
    .sort();
}

/**
 * One backup pass: `VACUUM INTO` a timestamped snapshot (consistent even while
 * the daemon is serving, same as `companion backup`), verify the copy, prune to
 * `keep`. Throws on failure; the scheduler turns that into a log line.
 */
export function runScheduledBackup(opts: ScheduledBackupOptions): string {
  if (!existsSync(opts.dbPath)) throw new Error(`no database at ${opts.dbPath}`);
  mkdirSync(opts.dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(opts.dir, `${PREFIX}${stamp}${SUFFIX}`);
  if (existsSync(target)) throw new Error(`${target} already exists; backups never overwrite`);

  const db = new Database(opts.dbPath, { readOnly: true });
  try {
    // VACUUM INTO rejects bound parameters; inline with SQLite quoting.
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }

  // An unverified backup is a belief, not a backup. A copy that fails its
  // check is deleted so it never counts toward retention or gets restored.
  const check = new Database(target, { readOnly: true });
  try {
    const [row] = check.pragma('integrity_check') as ReadonlyArray<{ integrity_check?: unknown }>;
    if (row?.integrity_check !== 'ok') {
      throw new Error(`snapshot failed its integrity check: ${String(row?.integrity_check)}`);
    }
  } catch (err) {
    check.close();
    rmSync(target, { force: true });
    throw err;
  }
  check.close();

  const snapshots = snapshotsIn(opts.dir);
  const prune = snapshots.slice(0, Math.max(0, snapshots.length - Math.max(1, opts.keep)));
  for (const file of prune) rmSync(join(opts.dir, file), { force: true });
  opts.log.info(`scheduled backup: ${target} (${statSync(target).size} bytes, integrity ok)`, {
    kept: snapshots.length - prune.length,
    pruned: prune.length,
  });
  return target;
}

/**
 * Daily database snapshots, daemon-side. The first run happens immediately on
 * a fresh directory; after a restart it waits out the remainder of the
 * interval since the newest snapshot, so bouncing the daemon does not churn
 * retention. A failed run logs loudly and the schedule keeps going; a backup
 * problem must never take the daemon down.
 */
export function startScheduledBackups(opts: ScheduledBackupOptions): () => void {
  const interval = opts.everyMs ?? BACKUP_INTERVAL_MS;
  let timer: NodeJS.Timeout;
  const tick = (): void => {
    try {
      runScheduledBackup(opts);
    } catch (err) {
      opts.log.error('scheduled backup failed', err);
    }
    timer = setTimeout(tick, interval);
    timer.unref?.();
  };

  const newest = snapshotsIn(opts.dir).at(-1);
  let initialDelay = 0;
  if (newest !== undefined) {
    const age = Date.now() - statSync(join(opts.dir, newest)).mtimeMs;
    initialDelay = Math.max(0, interval - age);
  }
  opts.log.info(`scheduled backups: every ${Math.round(interval / 60_000)}min into ${opts.dir} (keep ${opts.keep})`);
  timer = setTimeout(tick, initialDelay);
  timer.unref?.();
  return () => clearTimeout(timer);
}
