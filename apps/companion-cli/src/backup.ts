import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';

/** Tables a Companion database always has; the shape check before a restore. */
const SENTINEL_TABLES = ['users', 'module_migrations'];

function dbPath(home: string): string {
  return join(home, 'companion.db');
}

async function isRunning(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function human(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Snapshot the database to a single file, safely, WITHOUT stopping the daemon.
 *
 * `VACUUM INTO` is the whole reason this exists rather than staying a documented
 * `cp`. In WAL mode the recent transactions live in `companion.db-wal`, so copying
 * the main file alone yields a database missing whatever was committed most
 * recently, and copying both without coordination can yield a pair that disagree.
 * VACUUM INTO runs inside a read transaction and writes one internally consistent
 * file, so the backup is correct even while the instance is serving requests.
 *
 * Deliberately narrow about what a backup IS. The database is the irreplaceable
 * part; git clones are re-clonable from the forge and are excluded on purpose. The
 * moxxy home holding provider credentials is a separate volume with its own
 * lifecycle and is NOT in here, which the output says out loud rather than leaving
 * an operator to discover after a restore.
 */
export async function backupDatabase(home: string, destination: string, baseUrl: string): Promise<void> {
  const source = dbPath(home);
  if (!existsSync(source)) throw new Error(`No database at ${source}. Check --home.`);

  const target = resolve(destination);
  if (existsSync(target)) {
    throw new Error(`${target} already exists. Backups never overwrite: choose another path.`);
  }
  mkdirSync(dirname(target), { recursive: true });

  const live = await isRunning(baseUrl);
  const db = new Database(source, { readonly: true });
  try {
    // Bound parameters are not allowed in VACUUM INTO, so the path is inlined.
    // SQLite string quoting: double any single quote.
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }

  // Verify the artifact rather than trusting that the command returned. An
  // unverified backup is a belief, not a backup.
  const check = new Database(target, { readonly: true });
  try {
    const result = check.pragma('integrity_check', { simple: true });
    if (result !== 'ok') throw new Error(`the snapshot failed its integrity check: ${String(result)}`);
    for (const table of SENTINEL_TABLES) {
      check.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get();
    }
  } finally {
    check.close();
  }

  process.stdout.write(
    `Backed up to ${target} (${human(statSync(target).size)})\n` +
      `  integrity check: ok\n` +
      `  taken ${live ? 'while the daemon was running, which is supported' : 'with the daemon stopped'}\n` +
      `\nNOT included, by design:\n` +
      `  - git clones and worktrees (re-clonable from the forge)\n` +
      `  - the moxxy home holding AI provider credentials (its own volume)\n` +
      `\nRestore with: companion restore ${target}\n`,
  );
}

/**
 * Replace the database with a snapshot.
 *
 * Refuses while the daemon is reachable, for the same reason `role repair` does:
 * a running daemon holds state in memory and has the file open, so swapping it
 * underneath produces a process whose view of the world no longer exists on disk.
 *
 * Three things it does that a `cp` does not:
 *
 * - Verifies the snapshot BEFORE touching anything in place. Discovering a
 *   corrupt backup after deleting the original is the worst possible order.
 * - Moves the current database aside instead of deleting it. A restore that
 *   destroys the thing you might still need is not a restore.
 * - Removes the stale `-wal` and `-shm` sidecars. They belong to the database
 *   being replaced; leaving them next to a different file is how a "successful"
 *   restore comes up as a corrupt database.
 */
export async function restoreDatabase(home: string, sourcePath: string, baseUrl: string): Promise<void> {
  const source = resolve(sourcePath);
  if (!existsSync(source)) throw new Error(`No such file: ${source}`);

  if (await isRunning(baseUrl)) {
    throw new Error(
      `Companion is still running at ${baseUrl}.\n` +
        `Stop it first: restore replaces the database file and must not race the daemon.`,
    );
  }

  // Verify first, in place second.
  const check = new Database(source, { readonly: true });
  try {
    const result = check.pragma('integrity_check', { simple: true });
    if (result !== 'ok') throw new Error(`${source} failed its integrity check: ${String(result)}`);
    for (const table of SENTINEL_TABLES) {
      try {
        check.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get();
      } catch {
        throw new Error(`${source} has no '${table}' table, so it is not a Companion database.`);
      }
    }
  } finally {
    check.close();
  }

  const target = dbPath(home);
  mkdirSync(home, { recursive: true });
  const notes: string[] = [];
  if (existsSync(target)) {
    // A fixed suffix would be overwritten by a second attempt, which is exactly
    // when someone needs the first one.
    const aside = `${target}.pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    renameSync(target, aside);
    notes.push(`previous database kept at ${aside}`);
  }
  for (const sidecar of ['-wal', '-shm']) {
    const file = `${target}${sidecar}`;
    if (existsSync(file)) {
      rmSync(file);
      notes.push(`removed stale ${sidecar} sidecar`);
    }
  }
  copyFileSync(source, target);

  process.stdout.write(
    `Restored ${target} from ${source}\n${notes.map((n) => `  ${n}\n`).join('')}` +
      `\nStart Companion again; module migrations run on boot as usual.\n`,
  );
}
