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

test('an unreadable runner secret degrades that runner instead of failing construction', () => {
  const { db, values, secrets } = fixture();
  values.set('runner:runner-bad:token', 'unreachable');
  const throwing = {
    ...secrets,
    get: (key) => {
      if (values.get(key) === 'unreachable') throw new Error('secret store corrupt');
      return secrets.get(key);
    },
  };
  db.prepare(
    `INSERT INTO runners (id, name, kind, endpoint, token, scope, max_runs, enabled, created_at)
     VALUES ('runner-bad', 'Bad', 'remote', 'https://bad.test', 'companion-secret:v1', 'shared', 1, 1, 1)`,
  ).run();
  db.prepare(
    `INSERT INTO runners (id, name, kind, endpoint, token, scope, max_runs, enabled, created_at)
     VALUES ('runner-ok', 'Ok', 'remote', 'https://ok.test', 'ok-token', 'shared', 1, 1, 1)`,
  ).run();

  const store = new RunnersStore(db, throwing);
  const bad = store.get('runner-bad');
  assert.equal(bad.enabled, 0);
  assert.equal(bad.token, null);
  assert.match(store.secretError('runner-bad'), /secret store corrupt/);
  const ok = store.get('runner-ok');
  assert.equal(ok.enabled, 1);
  assert.equal(ok.token, 'ok-token');
  assert.equal(store.secretError('runner-ok'), null);

  store.update('runner-bad', { token: 'fresh', enabled: true });
  assert.equal(store.secretError('runner-bad'), null);
  assert.equal(store.get('runner-bad').token, 'fresh');
  assert.equal(store.get('runner-bad').enabled, 1);
});

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
