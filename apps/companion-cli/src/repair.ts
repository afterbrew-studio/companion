import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from '@moxxy/companion-services';

/**
 * Lockout recovery, and the reason it exists: revoking `users:manage` from the
 * wrong role, or disabling the wrong account, can leave nobody able to reach the
 * route that would undo it. This talks to the SQLite file directly, so it works
 * with the daemon STOPPED, which is the state a locked-out operator is in.
 *
 * It grants the built-in `admin` role to a user and clears any override that
 * would strip `users:manage` from that role. It does not invent permissions:
 * everything else the role holds still comes from the modules' own grants.
 */
export async function repairGrantAdmin(home: string, username: string, baseUrl: string): Promise<void> {
  const file = join(home, 'companion.db');
  if (!existsSync(file)) throw new Error(`No database at ${file}. Check --home.`);

  // A running daemon holds the effective grid in MEMORY, so an edit underneath
  // it would be invisible until a restart and could then be overwritten. WAL
  // mode lets a second writer take the lock whenever the daemon happens to be
  // idle, so the file lock alone is not a reliable "is it running" signal.
  if (await isRunning(baseUrl)) {
    throw new Error(
      `Companion is still running at ${baseUrl}.\n` +
        `Stop it first: repair edits the database directly and must not race the daemon.`,
    );
  }

  const db = new Database(file);
  try {
    if (isLocked(db)) {
      throw new Error(`${file} is locked by another process. Stop everything using it and retry.`);
    }
    const user = db.prepare(`SELECT username, role, disabled FROM users WHERE username = ?`).get(username) as
      | { username: string; role: string; disabled: number }
      | undefined;
    if (!user) {
      const known = (db.prepare(`SELECT username FROM users ORDER BY username`).all() as { username: string }[])
        .map((u) => u.username)
        .join(', ');
      throw new Error(`No user '${username}'. Known accounts: ${known || '(none)'}`);
    }

    const changes: string[] = [];
    db.transaction(() => {
      if (user.role !== 'admin') {
        db.prepare(`UPDATE users SET role = 'admin' WHERE username = ?`).run(username);
        changes.push(`role ${user.role} -> admin`);
      }
      if (user.disabled === 1) {
        db.prepare(`UPDATE users SET disabled = 0 WHERE username = ?`).run(username);
        changes.push('re-enabled the account');
      }
      // Only meaningful once the custom-roles migration has run; an older
      // database simply has no such table and needs no clearing.
      if (hasTable(db, 'role_permissions')) {
        const cleared = db
          .prepare(`DELETE FROM role_permissions WHERE role_id = 'admin' AND mode = 'revoke'`)
          .run().changes;
        if (cleared > 0) changes.push(`cleared ${cleared} revoke override(s) on the admin role`);
      }
      // Sessions cache the role at mint time; drop this user's so the next login
      // is issued against the repaired account.
      db.prepare(`DELETE FROM sessions WHERE username = ?`).run(username);
    })();

    if (!changes.length) {
      process.stdout.write(`'${username}' was already an enabled admin with no revoke overrides. Nothing to repair.\n`);
      return;
    }
    process.stdout.write(`Repaired '${username}':\n`);
    for (const c of changes) process.stdout.write(`  ${c}\n`);
    process.stdout.write('\nStart Companion and sign in as that user.\n');
  } finally {
    db.close();
  }
}

async function isRunning(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

function hasTable(db: Database, name: string): boolean {
  return !!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(name);
}

/** Second line of defence for a daemon on a different address than we probed. */
function isLocked(db: Database): boolean {
  try {
    db.prepare('BEGIN IMMEDIATE').run();
    db.prepare('ROLLBACK').run();
    return false;
  } catch {
    return true;
  }
}
