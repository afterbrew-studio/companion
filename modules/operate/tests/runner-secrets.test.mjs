import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import migrations from '../dist/api/migrations.js';
import { RunnersStore } from '../dist/api/runners-store.js';

function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  for (const migration of migrations) migration.up(db);
  const values = new Map();
  const secrets = {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => values.set(key, value),
    delete: (key) => values.delete(key),
  };
  return { db, values, secrets };
}

test('remote runner tokens migrate out of SQLite and never return there', () => {
  const { db, values, secrets } = fixture();
  db.prepare(
    `INSERT INTO runners (id, name, kind, endpoint, token, scope, max_runs, enabled, created_at)
     VALUES ('runner-old', 'Old', 'remote', 'https://runner.test', 'runner-plaintext', 'shared', 1, 1, 1)`,
  ).run();

  const store = new RunnersStore(db, secrets);
  assert.equal(store.get('runner-old').token, 'runner-plaintext');
  assert.doesNotMatch(db.prepare(`SELECT token FROM runners WHERE id = 'runner-old'`).get().token, /plaintext/);

  store.insert({
    id: 'runner-new', name: 'New', kind: 'remote', endpoint: 'https://runner.test', token: 'new-secret',
    scope: 'shared', ownerId: null, maxRuns: 1, workspaceIds: [],
  });
  assert.equal(store.get('runner-new').token, 'new-secret');
  assert.doesNotMatch(db.prepare(`SELECT token FROM runners WHERE id = 'runner-new'`).get().token, /new-secret/);
  store.delete('runner-new');
  assert.equal([...values.keys()].some((key) => key.includes('runner-new')), false);
});
