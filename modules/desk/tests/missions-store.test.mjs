import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import migrations from '../dist/api/migrations.js';
import { MissionsStore } from '../dist/api/missions-store.js';

function fixture() {
  const db = new Database(':memory:');
  for (const migration of migrations) migration.up(db);
  return { db, store: new MissionsStore(db) };
}

function mission(overrides = {}) {
  return {
    id: 'mission-1',
    kind: 'mission',
    title: 'Fix PR #42',
    workspaceId: 'ws-1',
    repo: 'acme/app',
    runnerId: null,
    harness: null,
    contexts: [{ kind: 'pull-request', repo: 'acme/app', number: 42 }],
    runId: null,
    archived: false,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

test('round-trips mission context and scopes every read to its owner', () => {
  const { db, store } = fixture();
  const record = mission();
  store.insert('alice', record);

  assert.deepEqual(store.getForOwner(record.id, 'alice'), record);
  assert.equal(store.getForOwner(record.id, 'bob'), null);
  assert.deepEqual(store.listForOwner('alice'), [record]);
  assert.deepEqual(store.listForOwner('bob'), []);
  db.close();
});

test('attaches at most one run and keeps archived missions outside the active list', () => {
  const { db, store } = fixture();
  store.insert('alice', mission());

  assert.equal(store.attachRun('mission-1', 'alice', 'run-1').runId, 'run-1');
  assert.equal(store.attachRun('mission-1', 'alice', 'run-2').runId, 'run-1');
  assert.equal(store.update('mission-1', 'alice', { archived: true }).archived, true);
  assert.deepEqual(store.listForOwner('alice'), []);
  assert.equal(store.listForOwner('alice', true)[0].runId, 'run-1');
  db.close();
});

test('an archived mission cannot acquire a late run', () => {
  const { db, store } = fixture();
  store.insert('alice', mission({ archived: true }));

  assert.equal(store.attachRun('mission-1', 'alice', 'run-late').runId, null);
  db.close();
});

test('updates shelf references atomically without changing the workspace', () => {
  const { db, store } = fixture();
  store.insert('alice', mission());
  const contexts = [
    { kind: 'issue', repo: 'acme/app', number: 7 },
    { kind: 'pull-request', repo: 'acme/api', number: 9 },
  ];

  const updated = store.update('mission-1', 'alice', { title: 'Release readiness', contexts });
  assert.equal(updated.workspaceId, 'ws-1');
  assert.equal(updated.title, 'Release readiness');
  assert.deepEqual(updated.contexts, contexts);
  db.close();
});

test('workspace cleanup removes only rows owned by that workspace', () => {
  const { db, store } = fixture();
  store.insert('alice', mission());
  store.insert('alice', mission({ id: 'mission-2', workspaceId: 'ws-2' }));

  assert.equal(store.removeForWorkspace('ws-1'), 1);
  assert.equal(store.getForOwner('mission-1', 'alice'), null);
  assert.equal(store.getForOwner('mission-2', 'alice').workspaceId, 'ws-2');
  db.close();
});

test('the Terminal migration keeps existing mission rows readable', () => {
  const db = new Database(':memory:');
  for (const migration of migrations.slice(0, 3)) migration.up(db);
  db.prepare(
    `INSERT INTO desk_missions
       (id, owner_id, title, workspace_id, repo, runner_id, harness, contexts, run_id, archived, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, NULL, NULL, '[]', NULL, 0, ?, ?)`,
  ).run('old-mission', 'alice', 'Existing mission', 'ws-1', 1_000, 1_000);
  for (const migration of migrations.slice(3)) migration.up(db);

  const stored = new MissionsStore(db).getForOwner('old-mission', 'alice');
  assert.equal(stored.kind, 'mission');
  assert.equal(stored.title, 'Existing mission');
  db.close();
});
