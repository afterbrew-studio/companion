import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import migrations from '../dist/api/migrations.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const appMigration = migrations.find((m) => m.name === 'code_github_app_accounts');

/** The github_accounts table exactly as it looked before app credentials existed. */
function legacyDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE github_accounts (
      id         TEXT PRIMARY KEY,
      login      TEXT NOT NULL,
      token      TEXT NOT NULL,
      purposes   TEXT NOT NULL DEFAULT '[]',
      scope      TEXT NOT NULL DEFAULT 'shared',
      owner_id   TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  db.prepare(
    `INSERT INTO github_accounts (id, login, token, purposes, scope, owner_id, created_at)
     VALUES ('gha-old', 'alice', 'github_pat_existing', '["fetch"]', 'all', 'alice', 1)`,
  ).run();
  return db;
}

const columns = (db) => db.prepare(`PRAGMA table_info(github_accounts)`).all().map((c) => c.name);

test('the migration adds the app columns to a database that already has accounts', () => {
  const db = legacyDb();
  appMigration.up(db);

  for (const name of ['kind', 'app_id', 'installation_id', 'private_key', 'token_expires_at']) {
    assert.ok(columns(db).includes(name), `missing column ${name}`);
  }
});

test('an account that predates the migration keeps working as a personal token', () => {
  const db = legacyDb();
  appMigration.up(db);

  const row = db.prepare(`SELECT * FROM github_accounts WHERE id = 'gha-old'`).get();
  assert.equal(row.token, 'github_pat_existing', 'an upgrade must not disturb a stored credential');
  // The default is what makes this additive: no backfill pass, no window where
  // an existing row has no kind and resolves as neither.
  assert.equal(row.kind, 'pat');
  assert.equal(row.token_expires_at, null, 'a PAT has no expiry we know about');
});

test('running the migration twice is not an error', () => {
  const db = legacyDb();
  appMigration.up(db);
  // A half-applied migration on a crashed upgrade must be resumable, not fatal.
  assert.doesNotThrow(() => appMigration.up(db));
  assert.equal(columns(db).filter((c) => c === 'kind').length, 1);
});

test('down removes the columns and leaves the accounts intact', () => {
  const db = legacyDb();
  appMigration.up(db);
  appMigration.down(db);

  assert.equal(columns(db).includes('kind'), false);
  assert.equal(db.prepare(`SELECT token FROM github_accounts WHERE id = 'gha-old'`).get().token, 'github_pat_existing');
});
