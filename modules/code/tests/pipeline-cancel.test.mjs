import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import migrations from '../dist/api/migrations.js';
import { PipelinesStore } from '../dist/api/pipelines-store.js';
import { Pipelines } from '../dist/api/pipelines.js';

function fixture(childState) {
  const db = new Database(':memory:');
  for (const migration of migrations) migration.up(db);
  const pipelinesStore = new PipelinesStore(db);
  pipelinesStore.insert({
    id: 'pipeline-agent',
    workspaceId: 'ws-1',
    type: 'platform',
    name: 'Agent gate',
    description: '',
    steps: [
      {
        type: 'inline',
        step: {
          kind: 'agent',
          name: 'Inspect',
          onFailure: 'halt',
          config: { prompt: 'Decide whether the repository is healthy.' },
        },
      },
    ],
    autoRunOnPrOpen: false,
    createdAt: 1,
    updatedAt: 1,
  });

  let rejectChild;
  const calls = [];
  const orchestrator = {
    runOneShot: (opts) => {
      opts.onQueued?.('queue-1');
      if (childState === 'running') opts.onStarted?.('agent-1');
      return new Promise((_resolve, reject) => {
        rejectChild = reject;
      });
    },
    cancelQueued: (id) => {
      calls.push(`cancel:${id}`);
      rejectChild?.(new Error('cancelled in queue'));
      return true;
    },
    stopRun: async (id) => {
      calls.push(`stop:${id}`);
      rejectChild?.(new Error('active run stopped'));
    },
    runners: { backend: () => ({}) },
  };
  const checkouts = {
    hasClone: () => true,
    withBaseWorktree: async (_repo, _key, _base, work) => work('/tmp/pipeline-agent'),
  };
  const store = {
    pipelines: pipelinesStore,
    repos: {
      get: () => ({ full_name: 'acme/app', default_branch: 'main' }),
      workspaceIds: () => ['ws-1'],
      inWorkspace: () => true,
    },
  };
  const engine = new Pipelines(
    {
      store,
      orchestrator,
      checkouts,
      github: () => null,
      checks: {},
      reviews: {},
      fixes: {},
      slop: () => null,
      moduleConfig: { get: () => null },
      secrets: { get: () => null, set: () => undefined, delete: () => undefined, keys: () => [] },
      audit: () => undefined,
      authorized: () => true,
      canAccessWorkspace: () => true,
    },
    () => undefined,
  );
  return { engine, pipelinesStore, calls };
}

for (const childState of ['queued', 'running']) {
  test(`pipeline cancellation stops a ${childState} agent child and remains terminal`, async () => {
    const { engine, pipelinesStore, calls } = fixture(childState);
    const run = engine.start('pipeline-agent', 'acme/app', 0, 'manual', 'alice');

    await engine.cancel(run.id, 'bob');
    await new Promise((resolve) => setImmediate(resolve));

    const stored = pipelinesStore.getRun(run.id);
    assert.equal(stored.status, 'cancelled');
    assert.equal(stored.steps[0].status, 'cancelled');
    assert.deepEqual(calls, childState === 'queued' ? ['cancel:queue-1'] : ['stop:agent-1']);
  });
}

test('graceful module shutdown persists interruption before reaping the child', async () => {
  const { engine, pipelinesStore, calls } = fixture('running');
  const run = engine.start('pipeline-agent', 'acme/app', 0, 'manual', 'alice');

  await engine.shutdown();
  await new Promise((resolve) => setImmediate(resolve));

  const stored = pipelinesStore.getRun(run.id);
  assert.equal(stored.status, 'error');
  assert.match(stored.steps[0].summary, /shutting down/);
  assert.deepEqual(calls, ['stop:agent-1']);
});

test('declining an approval leaves an explicit cancelled run, not a false pass', async () => {
  const { engine, pipelinesStore, calls } = fixture('queued');
  const pipeline = pipelinesStore.get('pipeline-agent');
  pipelinesStore.update('pipeline-agent', {
    steps: [
      {
        ...pipeline.steps[0],
        step: { ...pipeline.steps[0].step, requiresApproval: true },
      },
    ],
  });
  const run = engine.start('pipeline-agent', 'acme/app', 0, 'manual', 'alice');

  assert.equal(engine.resolveApproval(run.id, 0, false), true);
  await new Promise((resolve) => setImmediate(resolve));

  const stored = pipelinesStore.getRun(run.id);
  assert.equal(stored.status, 'cancelled');
  assert.equal(stored.steps[0].status, 'cancelled');
  assert.deepEqual(calls, [], 'the declined step never reaches the execution queue');
});

test('cancelling while review evidence is finishing prevents a later GitHub post', async () => {
  const db = new Database(':memory:');
  for (const migration of migrations) migration.up(db);
  const pipelinesStore = new PipelinesStore(db);
  pipelinesStore.insert({
    id: 'pipeline-review',
    workspaceId: 'ws-1',
    type: 'pr',
    name: 'Review gate',
    description: '',
    steps: [
      {
        type: 'inline',
        step: {
          kind: 'ai-review',
          name: 'Review',
          onFailure: 'halt',
          config: { post: true, failOn: 'never' },
        },
      },
    ],
    autoRunOnPrOpen: false,
    createdAt: 1,
    updatedAt: 1,
  });

  let finishReview;
  let posts = 0;
  let cancelled = 0;
  const reviews = {
    analyzePr: (_repo, _number, _userId, _options, onCreated) => {
      onCreated?.('review-1');
      return new Promise((resolve) => {
        finishReview = () =>
          resolve({
            id: 'review-1',
            status: 'pending',
            error: null,
            coverage: { state: 'complete' },
            findings: [],
            verdict: {
              risk: 'low',
              recommendation: 'approve',
              reviewBody: 'Looks safe.',
            },
          });
      });
    },
    cancel: async () => {
      cancelled++;
    },
    apply: async () => {
      posts++;
    },
  };
  const engine = new Pipelines(
    {
      store: {
        pipelines: pipelinesStore,
        prs: {
          get: () => ({
            repo: 'acme/app',
            number: 7,
            title: 'Change',
            author: 'contributor',
            headSha: 'abc123',
            baseRef: 'main',
          }),
        },
        repos: { get: () => null, workspaceIds: () => ['ws-1'], inWorkspace: () => true },
      },
      orchestrator: { runners: { backend: () => ({}) } },
      checkouts: {},
      github: () => null,
      checks: {},
      reviews,
      fixes: {},
      slop: () => null,
      moduleConfig: { get: () => null },
      secrets: { get: () => null, set: () => undefined, delete: () => undefined, keys: () => [] },
      audit: () => undefined,
      authorized: () => true,
      canAccessWorkspace: () => true,
    },
    () => undefined,
  );

  const run = engine.start('pipeline-review', 'acme/app', 7, 'manual', 'alice');
  await engine.cancel(run.id, 'alice');
  finishReview();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(cancelled, 1, 'the in-flight review is asked to stop');
  assert.equal(posts, 0, 'a late result cannot post after the durable cancel');
  assert.equal(pipelinesStore.getRun(run.id).status, 'cancelled');
});

test('cancelling a PR repair action stops the child run it created', async () => {
  const db = new Database(':memory:');
  for (const migration of migrations) migration.up(db);
  const pipelinesStore = new PipelinesStore(db);
  pipelinesStore.insert({
    id: 'pipeline-repair',
    workspaceId: 'ws-1',
    type: 'pr',
    name: 'Repair',
    description: '',
    steps: [
      {
        type: 'inline',
        step: {
          kind: 'pr-action',
          name: 'Fix checks',
          onFailure: 'halt',
          config: { action: 'pr.fix-checks' },
        },
      },
    ],
    autoRunOnPrOpen: false,
    createdAt: 1,
    updatedAt: 1,
  });

  let finishFix;
  const stopped = [];
  const fixes = {
    startCheckFix: (_repo, _number, _userId, opts) => {
      opts.onCreated?.('repair-1');
      return new Promise((resolve) => {
        finishFix = () => resolve({ id: 'repair-1' });
      });
    },
  };
  const engine = new Pipelines(
    {
      store: {
        pipelines: pipelinesStore,
        prs: {
          get: () => ({
            repo: 'acme/app',
            number: 7,
            title: 'Change',
            author: 'contributor',
            headSha: 'abc123',
            baseRef: 'main',
          }),
        },
        repos: { get: () => null, workspaceIds: () => ['ws-1'], inWorkspace: () => true },
      },
      orchestrator: {
        stopRun: async (id) => {
          stopped.push(id);
        },
        cancelQueued: () => false,
        runners: { backend: () => ({}) },
      },
      checkouts: {},
      github: () => ({}),
      checks: {},
      reviews: {},
      fixes,
      slop: () => null,
      moduleConfig: { get: () => null },
      secrets: { get: () => null, set: () => undefined, delete: () => undefined, keys: () => [] },
      audit: () => undefined,
      authorized: () => true,
      canAccessWorkspace: () => true,
    },
    () => undefined,
  );

  const run = engine.start('pipeline-repair', 'acme/app', 7, 'manual', 'alice');
  await engine.cancel(run.id, 'alice');
  finishFix();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(stopped, ['repair-1']);
  assert.equal(pipelinesStore.getRun(run.id).status, 'cancelled');
});
