import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Database } from '@moxxy/companion-services';
import { runScheduledBackup, startScheduledBackups } from '../dist/backup-job.js';

function harness(t) {
  const dir = mkdtempSync(join(tmpdir(), 'companion-backup-job-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const errors = [];
  const infos = [];
  const log = {
    debug() {},
    info(msg) {
      infos.push(String(msg));
    },
    warn() {},
    error(msg, err) {
      errors.push(`${msg}: ${String(err)}`);
    },
  };
  return { dir, backups: join(dir, 'backups'), errors, infos, log };
}

/** A minimal live database, in WAL mode like the real one. */
function seed(dir, users = ['alice']) {
  const dbPath = join(dir, 'companion.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE users (username TEXT PRIMARY KEY)`);
  for (const u of users) db.prepare(`INSERT INTO users (username) VALUES (?)`).run(u);
  return { db, dbPath };
}

function usersIn(file) {
  const db = new Database(file, { readOnly: true });
  try {
    return db.prepare(`SELECT username FROM users ORDER BY username`).all().map((r) => r.username);
  } finally {
    db.close();
  }
}

const snapshots = (dir) => readdirSync(dir).filter((f) => f.startsWith('companion-') && f.endsWith('.db')).sort();

test('a run produces a verified snapshot, including rows still in the WAL', (t) => {
  const { dir, backups, log, infos } = harness(t);
  const { db, dbPath } = seed(dir, ['alice']);
  db.prepare(`INSERT INTO users (username) VALUES ('bob')`).run();
  // Deliberately NOT checkpointed: bob lives in the -wal, not the main file.
  const target = runScheduledBackup({ dbPath, dir: backups, keep: 7, log });
  db.close();

  assert.deepEqual(usersIn(target), ['alice', 'bob']);
  assert.equal(snapshots(backups).length, 1);
  assert.match(infos.at(-1), /integrity ok/);
});

test('retention keeps the newest N snapshots and prunes the rest', async (t) => {
  const { dir, backups, log } = harness(t);
  const { db, dbPath } = seed(dir);
  t.after(() => db.close());

  const kept = [];
  for (let i = 0; i < 4; i += 1) {
    kept.push(runScheduledBackup({ dbPath, dir: backups, keep: 2, log }));
    // Stamps carry millisecond precision; keep consecutive runs distinct.
    await sleep(5);
  }
  const remaining = snapshots(backups);
  assert.equal(remaining.length, 2);
  assert.deepEqual(remaining.map((f) => join(backups, f)), kept.slice(-2), 'the newest snapshots survive');
});

test('a failing run logs the error and the scheduler keeps the daemon alive', async (t) => {
  const { dir, backups, errors, log } = harness(t);
  // No database at all: every run fails.
  const stop = startScheduledBackups({ dbPath: join(dir, 'missing.db'), dir: backups, keep: 7, log, everyMs: 60_000 });
  t.after(stop);

  for (let i = 0; i < 50 && errors.length === 0; i += 1) await sleep(10);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /scheduled backup failed/);
  assert.match(errors[0], /no database at/);
});

test('a restart inside the interval waits instead of stacking an extra snapshot', async (t) => {
  const { dir, backups, log } = harness(t);
  const { db, dbPath } = seed(dir);
  t.after(() => db.close());
  runScheduledBackup({ dbPath, dir: backups, keep: 7, log });
  assert.equal(snapshots(backups).length, 1);

  const stop = startScheduledBackups({ dbPath, dir: backups, keep: 7, log, everyMs: 60_000 });
  t.after(stop);
  await sleep(150);
  assert.equal(snapshots(backups).length, 1, 'a bounce within the interval must not churn retention');
});
