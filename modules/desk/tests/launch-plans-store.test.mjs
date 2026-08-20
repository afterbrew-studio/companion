import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import { LaunchPlansStore } from '../dist/api/launch-plans-store.js';
import migrations from '../dist/api/migrations.js';

function fixture() {
  const db = new Database(':memory:');
  for (const migration of migrations) migration.up(db);
  return { db, store: new LaunchPlansStore(db) };
}

function plan(id, overrides = {}) {
  const now = Date.now();
  return {
    id,
    workspaceId: 'ws-1',
    missions: [{
      title: 'Review PR 7',
      prompt: 'Inspect PR 7 and prepare a review.',
      repo: 'acme/app',
      contexts: [{ kind: 'pull-request', repo: 'acme/app', number: 7 }],
    }],
    status: 'pending',
    missionIds: [],
    createdAt: now,
    expiresAt: now + 30 * 60_000,
    executedAt: null,
    error: null,
    ...overrides,
  };
}

test('scopes plans to their owner and claims a pending plan once', () => {
  const { db, store } = fixture();
  store.insert('alice', plan('plan-1'));

  assert.equal(store.getForOwner('plan-1', 'bob'), null);
  assert.deepEqual(store.listForOwner('bob', 'ws-1'), []);
  assert.equal(store.claim('plan-1', 'bob'), false);
  assert.equal(store.claim('plan-1', 'alice'), true);
  assert.equal(store.claim('plan-1', 'alice'), false);
  db.close();
});

test('expires only the requested owner plans', () => {
  const { db, store } = fixture();
  store.insert('alice', plan('alice-plan', { expiresAt: 1 }));
  store.insert('bob', plan('bob-plan', { expiresAt: 1 }));

  assert.equal(store.expireForOwner('alice'), 1);
  assert.equal(store.getForOwner('alice-plan', 'alice').status, 'expired');
  assert.equal(store.getForOwner('bob-plan', 'bob').status, 'pending');
  db.close();
});

test('prunes old terminal outcomes while retaining active plans', () => {
  const { db, store } = fixture();
  const now = Date.now();
  const old = now - 31 * 24 * 60 * 60_000;
  store.insert('alice', plan('old-complete', {
    status: 'completed',
    createdAt: old,
    expiresAt: old,
    executedAt: old,
  }));
  store.insert('alice', plan('old-executing', {
    status: 'executing',
    createdAt: old,
    expiresAt: old,
  }));

  store.insert('alice', plan('fresh'));

  assert.equal(store.getForOwner('old-complete', 'alice'), null);
  assert.equal(store.getForOwner('old-executing', 'alice').status, 'executing');
  assert.equal(store.getForOwner('fresh', 'alice').status, 'pending');
  db.close();
});
