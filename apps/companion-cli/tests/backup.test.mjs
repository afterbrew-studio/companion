import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import { backupDatabase, restoreDatabase } from '../dist/backup.js';

/** An unreachable address, so isRunning() answers "stopped" without a server. */
const STOPPED = 'http://127.0.0.1:9';

function home(t) {
  const dir = mkdtempSync(join(tmpdir(), 'companion-backup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A minimal but genuine Companion database, in WAL mode like the real one. */
function seed(dir, users = ['alice']) {
  const db = new Database(join(dir, 'companion.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE users (username TEXT PRIMARY KEY, role TEXT NOT NULL)`);
  db.exec(`CREATE TABLE module_migrations (module_id TEXT, version INTEGER, name TEXT, applied_at INTEGER)`);
  for (const u of users) db.prepare(`INSERT INTO users (username, role) VALUES (?, 'admin')`).run(u);
  db.prepare(`INSERT INTO module_migrations VALUES ('core', 1, 'init', 0)`).run();
  return db;
}

function usersIn(file) {
  const db = new Database(file, { readOnly: true });
  try {
    return db.prepare(`SELECT username FROM users ORDER BY username`).all().map((r) => r.username);
  } finally {
    db.close();
  }
}

// ---------- backup ----------

test('a backup captures rows still sitting in the WAL', async (t) => {
  // The reason this is VACUUM INTO and not cp: in WAL mode recent commits live in
  // companion.db-wal, so copying the main file alone loses them.
  const dir = home(t);
  const db = seed(dir, ['alice']);
  db.prepare(`INSERT INTO users (username, role) VALUES ('bob', 'admin')`).run();
  // Deliberately NOT checkpointed: bob is in the -wal, not the main file.
  const out = join(dir, 'snap.db');
  await backupDatabase(dir, out, STOPPED);
  db.close();

  assert.deepEqual(usersIn(out), ['alice', 'bob']);
});

test('a backup works while the database is open by another connection', async (t) => {
  // Which is what "safe while the daemon is running" means in practice.
  const dir = home(t);
  const db = seed(dir);
  const out = join(dir, 'snap.db');
  await assert.doesNotReject(() => backupDatabase(dir, out, STOPPED));
  db.close();
  assert.ok(existsSync(out));
});

test('a backup is one file, with no sidecars left beside it', async (t) => {
  const dir = home(t);
  seed(dir).close();
  await backupDatabase(dir, join(dir, 'snap.db'), STOPPED);
  const strays = readdirSync(dir).filter((f) => f.startsWith('snap.db') && f !== 'snap.db');
  assert.deepEqual(strays, [], 'a snapshot that needs sidecars is not one file');
});

test('a backup never overwrites, because that is how you lose the good one', async (t) => {
  const dir = home(t);
  seed(dir).close();
  const out = join(dir, 'snap.db');
  await backupDatabase(dir, out, STOPPED);
  await assert.rejects(() => backupDatabase(dir, out, STOPPED), /already exists/);
});

test('a missing database is named, not guessed at', async (t) => {
  const dir = home(t);
  await assert.rejects(() => backupDatabase(dir, join(dir, 'snap.db'), STOPPED), /No database at/);
});

// ---------- restore ----------

test('a restore replaces the database and keeps the old one aside', async (t) => {
  const dir = home(t);
  seed(dir, ['alice']).close();
  const snap = join(dir, 'snap.db');
  await backupDatabase(dir, snap, STOPPED);

  // Diverge, then go back.
  const db = new Database(join(dir, 'companion.db'));
  db.prepare(`INSERT INTO users (username, role) VALUES ('mistake', 'admin')`).run();
  db.close();

  await restoreDatabase(dir, snap, STOPPED);
  assert.deepEqual(usersIn(join(dir, 'companion.db')), ['alice']);
  const kept = readdirSync(dir).filter((f) => f.includes('pre-restore'));
  assert.equal(kept.length, 1, 'a restore that destroys what you might still need is not a restore');
  assert.deepEqual(usersIn(join(dir, kept[0])).sort(), ['alice', 'mistake']);
});

test('stale -wal and -shm sidecars are removed, or the restore comes up corrupt', async (t) => {
  const dir = home(t);
  seed(dir).close();
  const snap = join(dir, 'snap.db');
  await backupDatabase(dir, snap, STOPPED);
  // Sidecars belonging to the database about to be replaced.
  writeFileSync(join(dir, 'companion.db-wal'), 'stale');
  writeFileSync(join(dir, 'companion.db-shm'), 'stale');

  await restoreDatabase(dir, snap, STOPPED);
  assert.equal(existsSync(join(dir, 'companion.db-wal')), false);
  assert.equal(existsSync(join(dir, 'companion.db-shm')), false);
});

test('a file that is not a Companion database is refused BEFORE anything is touched', async (t) => {
  const dir = home(t);
  seed(dir, ['alice']).close();
  const notOurs = join(dir, 'other.db');
  const other = new Database(notOurs);
  other.exec(`CREATE TABLE something (x INTEGER)`);
  other.close();

  await assert.rejects(() => restoreDatabase(dir, notOurs, STOPPED), /not a Companion database/);
  // The order matters more than the message: verify first, replace second.
  assert.deepEqual(usersIn(join(dir, 'companion.db')), ['alice']);
  assert.equal(readdirSync(dir).some((f) => f.includes('pre-restore')), false);
});

test('a corrupt snapshot is refused and leaves the live database alone', async (t) => {
  const dir = home(t);
  seed(dir, ['alice']).close();
  const junk = join(dir, 'junk.db');
  writeFileSync(junk, 'this is not sqlite at all');

  await assert.rejects(() => restoreDatabase(dir, junk, STOPPED));
  assert.deepEqual(usersIn(join(dir, 'companion.db')), ['alice']);
});

test('a missing snapshot is named rather than producing an empty database', async (t) => {
  const dir = home(t);
  seed(dir).close();
  await assert.rejects(() => restoreDatabase(dir, join(dir, 'nope.db'), STOPPED), /No such file/);
});

test('restore refuses while the daemon answers, the same fence as role repair', async (t) => {
  const { createServer } = await import('node:http');
  const server = createServer((_req, res) => res.writeHead(200).end('ok'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const dir = home(t);
  seed(dir, ['alice']).close();
  const snap = join(dir, 'snap.db');
  await backupDatabase(dir, snap, STOPPED);

  await assert.rejects(
    () => restoreDatabase(dir, snap, `http://127.0.0.1:${server.address().port}`),
    /still running/,
  );
  assert.deepEqual(usersIn(join(dir, 'companion.db')), ['alice']);
});
