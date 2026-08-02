import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import migrations from '../dist/api/migrations.js';
import { RunsStore } from '../dist/api/runs-store.js';

function insertRun(store, fields) {
  store.insert({
    id: fields.id,
    kind: fields.kind ?? 'analysis',
    status: fields.status ?? 'completed',
    title: fields.title ?? fields.id,
    cwd: fields.cwd ?? `/tmp/${fields.id}`,
    repo: fields.repo ?? null,
    issueNumber: fields.issueNumber ?? null,
    proposalId: null,
    branch: null,
    prUrl: null,
    model: 'test-model',
    runnerId: null,
    userId: fields.userId ?? null,
    task: 'code.pr-review',
    harness: 'moxxy',
    createdAt: fields.createdAt ?? 0,
    updatedAt: fields.createdAt ?? 0,
    inputTokens: 1,
    outputTokens: 2,
    outcome: fields.outcome ?? null,
  });
}

test('run queue is bounded, body-free, workspace-scoped, and user-private', () => {
  const db = new Database(':memory:');
  for (const migration of migrations) migration.up(db);
  const store = new RunsStore(db);
  const largeEvidence = 'terminal evidence '.repeat(8_000);
  const statuses = ['review', 'running', 'completed', 'failed'];

  for (let index = 0; index < 125; index += 1) {
    insertRun(store, {
      id: `run-${String(index).padStart(3, '0')}`,
      status: statuses[index % statuses.length],
      title: index === 42 ? 'Unique queue marker' : `Review ${index}`,
      cwd: `/private/worktrees/${largeEvidence.slice(0, 100)}/${index}`,
      repo: 'acme/app',
      userId: 'alice',
      createdAt: index,
      outcome: largeEvidence,
    });
    store.setVerification(`run-${String(index).padStart(3, '0')}`, {
      status: 'passed',
      commands: [{ command: largeEvidence, exitCode: 0, output: largeEvidence }],
      completedAt: index,
    });
  }

  insertRun(store, {
    id: 'other-user', kind: 'interactive', title: 'Private chat', userId: 'bob', createdAt: 1_000,
  });
  insertRun(store, {
    id: 'other-repo', repo: 'other/private', title: 'Outside workspace', userId: 'alice', createdAt: 999,
  });
  insertRun(store, {
    id: 'global-report', kind: 'report', title: 'Global report', createdAt: 998,
  });

  const first = store.listPage({ userId: 'alice', repoNames: ['acme/app'], limit: 5_000, offset: -20 });
  assert.equal(first.total, 126);
  assert.equal(first.rows.length, 100);
  assert.equal(first.rows[0].id, 'global-report');
  assert.ok(first.rows.every((run) => run.id !== 'other-user' && run.id !== 'other-repo'));
  assert.ok(first.rows.every((run) => !Object.hasOwn(run, 'cwd')));
  assert.ok(first.rows.every((run) => !Object.hasOwn(run, 'verification')));
  assert.ok(first.rows.every((run) => !Object.hasOwn(run, 'outcome')));

  const second = store.listPage({ userId: 'alice', repoNames: ['acme/app'], limit: 100, offset: 100 });
  assert.equal(second.rows.length, 26);
  const search = store.listPage({ userId: 'alice', repoNames: ['acme/app'], q: 'queue marker' });
  assert.equal(search.total, 1);
  assert.equal(search.rows[0].id, 'run-042');
  const active = store.listPage({ userId: 'alice', repoNames: ['acme/app'], status: 'active' });
  assert.equal(active.total, 63);
  assert.ok(active.rows.every((run) => run.status === 'review' || run.status === 'running'));
  const repo = store.listPage({ userId: 'alice', repoNames: ['acme/app'], repo: 'acme/app' });
  assert.equal(repo.total, 125);
  db.close();
});
