import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import migrations from '../dist/api/migrations.js';
import { PipelinesStore } from '../dist/api/pipelines-store.js';

function fixture() {
  const db = new Database(':memory:');
  for (const migration of migrations) migration.up(db);
  return new PipelinesStore(db);
}

function run(id, steps = []) {
  return {
    id,
    pipelineId: 'pipeline-quality',
    ownerId: 'maintainer-a',
    workspaceId: 'ws-1',
    pipelineName: 'Quality gate',
    target: 'pr',
    repo: 'acme/app',
    prNumber: 7,
    status: 'running',
    trigger: 'pr-opened',
    steps,
    createdAt: 1,
    finishedAt: null,
  };
}

test('a webhook retry cannot admit the same pipeline and PR head twice', () => {
  const store = fixture();
  const key = 'pipeline-quality:pr:acme/app:7:abc123:pr-opened';

  assert.equal(store.insertRun(run('plr-first'), key), true);
  assert.equal(store.insertRun(run('plr-retry'), key), false);
  assert.equal(store.getRunByIdempotencyKey(key).id, 'plr-first');
  assert.equal(store.getRun('plr-first').ownerId, 'maintainer-a');
});

test('manual pipeline starts remain repeatable', () => {
  const store = fixture();
  assert.equal(store.insertRun(run('plr-one')), true);
  assert.equal(store.insertRun(run('plr-two')), true);
});

test('cancellation is terminal and a late step cannot revive the run', () => {
  const store = fixture();
  const log = { text: 'building\n', sequence: 1, truncated: false, updatedAt: 10 };
  store.insertRun(
    run('plr-cancel', [
      {
        name: 'Build',
        kind: 'executable',
        status: 'running',
        summary: 'Command is running',
        detail: null,
        log,
        startedAt: 2,
        finishedAt: null,
      },
      {
        name: 'Review',
        kind: 'ai-review',
        status: 'pending',
        summary: null,
        detail: null,
        startedAt: null,
        finishedAt: null,
      },
    ]),
  );

  const cancelled = store.cancelRun('plr-cancel', 'cancelled by maintainer-a');
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.steps[0].status, 'cancelled');
  assert.deepEqual(cancelled.steps[0].log, log, 'the last durable output survives cancellation');
  assert.equal(cancelled.steps[1].status, 'skipped');

  assert.equal(
    store.updateRunningRun('plr-cancel', { status: 'passed', steps: [] }),
    false,
    'a late completion loses the compare-and-set race',
  );
  assert.equal(store.getRun('plr-cancel').status, 'cancelled');
});

test('history lists omit heavy evidence while explicit detail and log reads retain it', () => {
  const store = fixture();
  const log = { text: 'x'.repeat(64_000), sequence: 9, truncated: true, updatedAt: 20 };
  store.insertRun(
    run('plr-log', [
      {
        name: 'Build',
        kind: 'executable',
        status: 'running',
        summary: null,
        detail: 'x'.repeat(20_000),
        log,
        startedAt: 2,
        finishedAt: null,
      },
    ]),
  );

  assert.equal(store.listWorkspaceRuns('ws-1')[0].steps[0].log, undefined);
  assert.equal(store.listWorkspaceRuns('ws-1')[0].steps[0].detail, null);
  assert.deepEqual(store.getRunScope('plr-log'), { repo: 'acme/app' });
  assert.deepEqual(store.getStepLog('plr-log', 0), log);
  assert.deepEqual(store.getRun('plr-log').steps[0].log, log);
  assert.equal(store.getRun('plr-log').steps[0].detail.length, 20_000);
  assert.equal(store.getStepLog('plr-log', 1), undefined);
});

test('boot recovery preserves evidence and marks unfinished work honestly', () => {
  const store = fixture();
  const log = { text: 'last line', sequence: 3, truncated: false, updatedAt: 30 };
  store.insertRun(
    run('plr-restart', [
      {
        name: 'Build',
        kind: 'executable',
        status: 'running',
        summary: null,
        detail: null,
        log,
        startedAt: 2,
        finishedAt: null,
      },
    ]),
  );

  assert.equal(store.markInterruptedRuns(), 1);
  const recovered = store.getRun('plr-restart');
  assert.equal(recovered.status, 'error');
  assert.equal(recovered.steps[0].status, 'error');
  assert.deepEqual(recovered.steps[0].log, log);
});
