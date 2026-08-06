import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import migrations from '../dist/api/migrations.js';
import { WorkbenchActionsStore } from '../dist/api/workbench-actions-store.js';

function fixture() {
  const db = new Database(':memory:');
  for (const migration of migrations) migration.up(db);
  return { db, store: new WorkbenchActionsStore(db) };
}

function proposal(overrides = {}) {
  return {
    id: 'action-1',
    workspaceId: 'ws-1',
    requestedBy: 'maintainer',
    source: 'assistant',
    request: {
      action: 'spec.create',
      repo: 'acme/app',
      title: 'Search requirements',
      content: '# Search\n\nThe reviewed requirements.',
    },
    subject: { type: 'content', area: 'specification', repo: 'acme/app' },
    targetId: 'new-spec:acme/app',
    targetVersion: 'a1b2c3',
    title: 'Create specification: Search requirements',
    summary: '37 characters of reviewed Markdown for acme/app.',
    consequence: 'This adds a virtual specification; it does not start implementation or write to GitHub.',
    impact: 'local',
    href: '#/specs',
    status: 'pending',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    executedAt: null,
    error: null,
    result: null,
    ...overrides,
  };
}

test('round-trips the exact proposal and scopes listings to its owner', () => {
  const { db, store } = fixture();
  const action = proposal();
  store.insert(action);

  assert.deepEqual(store.get(action.id), action);
  assert.deepEqual(store.list('maintainer', { workspaceId: 'ws-1' }), [action]);
  assert.deepEqual(store.list('someone-else'), []);
  db.close();
});

test('claims a proposal once and persists its result', () => {
  const { db, store } = fixture();
  const action = proposal();
  store.insert(action);

  assert.equal(store.claim('action-1', 'maintainer'), true);
  assert.equal(store.claim('action-1', 'maintainer'), false);
  assert.equal(store.cancel('action-1', 'maintainer'), false);

  store.complete('action-1', { message: 'Specification created.', href: '#/specs/spec-1' });
  assert.deepEqual(store.get('action-1'), {
    ...action,
    status: 'completed',
    executedAt: store.get('action-1').executedAt,
    result: { message: 'Specification created.', href: '#/specs/spec-1' },
  });
  assert.equal(typeof store.get('action-1').executedAt, 'number');
  db.close();
});

test('expires stale proposals and never replays interrupted executions', () => {
  const { db, store } = fixture();
  store.insert(proposal({ id: 'expired', expiresAt: 100 }));
  store.insert(proposal({ id: 'interrupted' }));

  assert.equal(store.expire(101), 1);
  assert.equal(store.claim('expired', 'maintainer'), false);
  assert.equal(store.claim('interrupted', 'maintainer'), true);
  assert.equal(store.failInterrupted(), 1);

  assert.equal(store.get('expired').status, 'expired');
  assert.equal(store.get('interrupted').status, 'failed');
  assert.match(store.get('interrupted').error, /verify the target/);
  db.close();
});
