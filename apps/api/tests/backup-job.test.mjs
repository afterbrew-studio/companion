import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  // Absent by default; a test that wants the credential archive creates it.
  return { dir, backups: join(dir, 'backups'), moxxy: join(dir, 'moxxy'), errors, infos, log };
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

const archives = (dir) => readdirSync(dir).filter((f) => f.startsWith('moxxy-home-') && f.endsWith('.tar.gz')).sort();

test('a run produces a verified snapshot, including rows still in the WAL', (t) => {
  const { dir, backups, moxxy, log, infos } = harness(t);
  const { db, dbPath } = seed(dir, ['alice']);
  db.prepare(`INSERT INTO users (username) VALUES ('bob')`).run();
  // Deliberately NOT checkpointed: bob lives in the -wal, not the main file.
  const target = runScheduledBackup({ dbPath, dir: backups, keep: 7, moxxyDir: moxxy, log });
  db.close();

  assert.deepEqual(usersIn(target), ['alice', 'bob']);
  assert.equal(snapshots(backups).length, 1);
  assert.equal(infos.some((msg) => /integrity ok/.test(msg)), true);
});

test('retention keeps the newest N snapshots and prunes the rest', async (t) => {
  const { dir, backups, moxxy, log } = harness(t);
  const { db, dbPath } = seed(dir);
  t.after(() => db.close());

  const kept = [];
  for (let i = 0; i < 4; i += 1) {
    kept.push(runScheduledBackup({ dbPath, dir: backups, keep: 2, moxxyDir: moxxy, log }));
    // Stamps carry millisecond precision; keep consecutive runs distinct.
    await sleep(5);
  }
  const remaining = snapshots(backups);
  assert.equal(remaining.length, 2);
  assert.deepEqual(remaining.map((f) => join(backups, f)), kept.slice(-2), 'the newest snapshots survive');
});

test('a failing run logs the error and the scheduler keeps the daemon alive', async (t) => {
  const { dir, backups, moxxy, errors, log } = harness(t);
  // No database at all: every run fails.
  const stop = startScheduledBackups({
    dbPath: join(dir, 'missing.db'),
    dir: backups,
    keep: 7,
    moxxyDir: moxxy,
    log,
    everyMs: 60_000,
  });
  t.after(stop);

  for (let i = 0; i < 50 && errors.length === 0; i += 1) await sleep(10);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /scheduled backup failed/);
  assert.match(errors[0], /no database at/);
});

test('a restart inside the interval waits instead of stacking an extra snapshot', async (t) => {
  const { dir, backups, moxxy, log } = harness(t);
  const { db, dbPath } = seed(dir);
  t.after(() => db.close());
  runScheduledBackup({ dbPath, dir: backups, keep: 7, moxxyDir: moxxy, log });
  assert.equal(snapshots(backups).length, 1);

  const stop = startScheduledBackups({ dbPath, dir: backups, keep: 7, moxxyDir: moxxy, log, everyMs: 60_000 });
  t.after(stop);
  await sleep(150);
  assert.equal(snapshots(backups).length, 1, 'a bounce within the interval must not churn retention');
});

test('the moxxy credential home is archived beside the snapshot and restores byte for byte', (t) => {
  const { dir, backups, moxxy, log, infos } = harness(t);
  const { db, dbPath } = seed(dir);
  t.after(() => db.close());
  mkdirSync(join(moxxy, 'sessions'), { recursive: true });
  writeFileSync(join(moxxy, 'vault.json'), '{"provider":"secret"}');
  writeFileSync(join(moxxy, 'vault.key'), 'key-material');

  runScheduledBackup({ dbPath, dir: backups, keep: 7, moxxyDir: moxxy, log });
  const [archive] = archives(backups);
  assert.notEqual(archive, undefined, 'a moxxy-home tarball sits beside the DB snapshot');
  assert.equal(infos.some((msg) => msg.includes(archive) && msg.includes('moxxy home')), true);

  const restored = join(dir, 'restored');
  mkdirSync(restored);
  execFileSync('tar', ['-xzf', join(backups, archive), '-C', restored]);
  assert.equal(readFileSync(join(restored, 'vault.json'), 'utf8'), '{"provider":"secret"}');
  assert.equal(readFileSync(join(restored, 'vault.key'), 'utf8'), 'key-material');
});

test('a missing moxxy home skips its archive with one log line and no error', (t) => {
  const { dir, backups, moxxy, log, infos, errors } = harness(t);
  const { db, dbPath } = seed(dir);
  t.after(() => db.close());

  runScheduledBackup({ dbPath, dir: backups, keep: 7, moxxyDir: moxxy, log });
  assert.equal(snapshots(backups).length, 1, 'the DB snapshot still happens');
  assert.equal(archives(backups).length, 0);
  assert.equal(errors.length, 0);
  assert.equal(infos.filter((msg) => msg.includes('skipping its backup')).length, 1);
});

test('moxxy archives honor the same retention count, pruned independently by prefix', async (t) => {
  const { dir, backups, moxxy, log } = harness(t);
  const { db, dbPath } = seed(dir);
  t.after(() => db.close());
  mkdirSync(moxxy, { recursive: true });
  writeFileSync(join(moxxy, 'vault.json'), '{}');

  for (let i = 0; i < 4; i += 1) {
    runScheduledBackup({ dbPath, dir: backups, keep: 2, moxxyDir: moxxy, log });
    await sleep(5);
  }
  const remainingArchives = archives(backups);
  assert.equal(remainingArchives.length, 2);
  assert.equal(snapshots(backups).length, 2);
  // Paired stamps: the surviving archives belong to the surviving snapshots.
  const stampOf = (f) => f.replace(/^(companion-|moxxy-home-)/, '').replace(/(\.db|\.tar\.gz)$/, '');
  assert.deepEqual(remainingArchives.map(stampOf), snapshots(backups).map(stampOf));
});
