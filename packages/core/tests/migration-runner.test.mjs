import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import { MigrationRunner } from '../dist/server/index.js';

function harness(t) {
  const warnings = [];
  const log = {
    info() {},
    warn(msg) {
      warnings.push(String(msg));
    },
    error() {},
    debug() {},
  };
  const dir = mkdtempSync(join(tmpdir(), 'companion-migrations-'));
  const db = new Database(join(dir, 'companion.db'));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { db, log, warnings, runner: new MigrationRunner(db, log) };
}

const migration = (version) => ({
  version,
  name: `step-${version}`,
  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS probe_${version} (x INTEGER)`);
  },
});

function withoutOverride(t) {
  const previous = process.env.COMPANION_ALLOW_SCHEMA_AHEAD;
  delete process.env.COMPANION_ALLOW_SCHEMA_AHEAD;
  t.after(() => {
    if (previous === undefined) delete process.env.COMPANION_ALLOW_SCHEMA_AHEAD;
    else process.env.COMPANION_ALLOW_SCHEMA_AHEAD = previous;
  });
}

test('a ledger newer than the binary refuses to boot, naming module and versions', (t) => {
  withoutOverride(t);
  const { runner } = harness(t);
  // The database was migrated by a newer build (v1..v3); this binary knows v1.
  runner.migrateUp('probe', [migration(1), migration(2), migration(3)]);

  assert.throws(
    () => runner.migrateUp('probe', [migration(1)]),
    (err) => {
      const msg = String(err.message);
      assert.match(msg, /'probe'/);
      assert.match(msg, /v3 applied/);
      assert.match(msg, /up to v1/);
      assert.match(msg, /Upgrade the binary|restore the pre-upgrade backup/);
      assert.match(msg, /COMPANION_ALLOW_SCHEMA_AHEAD=1/);
      return true;
    },
  );
});

test('COMPANION_ALLOW_SCHEMA_AHEAD=1 boots anyway, with a loud warning', (t) => {
  withoutOverride(t);
  const { runner, warnings } = harness(t);
  runner.migrateUp('probe', [migration(1), migration(2)]);

  process.env.COMPANION_ALLOW_SCHEMA_AHEAD = '1';
  assert.doesNotThrow(() => runner.migrateUp('probe', [migration(1)]));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /COMPANION_ALLOW_SCHEMA_AHEAD=1/);
  assert.match(warnings[0], /'probe'/);
  assert.equal(runner.appliedVersion('probe'), 2, 'nothing was rolled back or re-applied');
});

test('an equal ledger is untouched: no throw, no warning, no re-apply', (t) => {
  withoutOverride(t);
  const { runner, warnings } = harness(t);
  const known = [migration(1), migration(2)];
  runner.migrateUp('probe', known);

  assert.doesNotThrow(() => runner.migrateUp('probe', known));
  assert.deepEqual(warnings, []);
  assert.equal(runner.appliedVersion('probe'), 2);
});

test('an older ledger still migrates forward as before', (t) => {
  withoutOverride(t);
  const { runner, warnings, db } = harness(t);
  runner.migrateUp('probe', [migration(1)]);

  runner.migrateUp('probe', [migration(1), migration(2)]);
  assert.equal(runner.appliedVersion('probe'), 2);
  assert.deepEqual(warnings, []);
  db.prepare(`SELECT 1 FROM probe_2 LIMIT 1`).get();
});
