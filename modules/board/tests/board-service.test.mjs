import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, insertDeveloper, insertTask } from './fixture.mjs';

test('developer blocker is deduplicated across ticks and service restarts', async () => {
  const { db, store, notifications, makeService } = fixture();
  insertTask(store);

  const first = makeService();
  await first.tick();
  await first.tick();
  first.dispose();
  assert.equal(notifications.length, 1);
  assert.equal(store.hasActiveBlocker('tsk-1', 'developer'), true);

  const restarted = makeService();
  await restarted.tick();
  restarted.dispose();
  assert.equal(notifications.length, 1);
  db.close();
});

test('parking clears a blocker so requeue can notify for a new lifecycle', async () => {
  const { db, store, notifications, makeService } = fixture();
  insertTask(store);

  const service = makeService();
  await service.tick();
  service.dispose();
  await service.moveTask('tsk-1', 'backlog');
  assert.equal(store.hasActiveBlocker('tsk-1', 'developer'), false);
  await service.moveTask('tsk-1', 'ready');

  const restarted = makeService();
  await restarted.tick();
  restarted.dispose();
  assert.equal(notifications.length, 2);
  assert.equal(store.hasActiveBlocker('tsk-1', 'developer'), true);
  db.close();
});

test('manual completion clears the reviewer blocker', async () => {
  const { db, store, notifications, makeService } = fixture();
  insertTask(store, { status: 'in_review', stage: 'awaiting_review', prNumber: 14, prUrl: 'https://example.test/pr/14' });

  const service = makeService();
  await service.tick();
  service.dispose();
  assert.equal(notifications.length, 1);
  assert.equal(store.hasActiveBlocker('tsk-1', 'reviewer'), true);

  await service.moveTask('tsk-1', 'done');
  assert.equal(store.hasActiveBlocker('tsk-1', 'reviewer'), false);
  db.close();
});

test('retry transitions stay silent until the task finally fails', async () => {
  const { db, store, notifications, makeService } = fixture();
  insertTask(store);

  const service = makeService();
  service.attemptFail('tsk-1', 'first failure');
  assert.equal(store.getTask('tsk-1').status, 'ready');
  assert.equal(notifications.length, 0);

  service.attemptFail('tsk-1', 'second failure');
  assert.equal(store.getTask('tsk-1').status, 'ready');
  assert.equal(notifications.length, 0);

  service.attemptFail('tsk-1', 'final failure');
  assert.equal(store.getTask('tsk-1').status, 'failed');
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].kind, 'error');
  await new Promise((resolve) => setImmediate(resolve));
  service.dispose();
  db.close();
});

test('remediation work does not notify while it is running', async () => {
  const { db, store, notifications, makeService } = fixture();
  insertTask(store, {
    status: 'in_review',
    stage: 'awaiting_review',
    firstWorker: 'Developer',
    prNumber: 14,
    prUrl: 'https://example.test/pr/14',
  });

  const service = makeService();
  service.bindBack('tsk-1', 'address_review', 'changes requested', store.getConfig('ws-1'));
  assert.equal(store.getTask('tsk-1').status, 'ready');
  assert.equal(notifications.length, 0);
  await new Promise((resolve) => setImmediate(resolve));
  service.dispose();
  db.close();
});

test('deleting a blocked task removes its durable blocker state', async () => {
  const { db, store, makeService } = fixture();
  insertTask(store);

  const service = makeService();
  await service.tick();
  service.dispose();
  assert.equal(store.hasActiveBlocker('tsk-1', 'developer'), true);

  await service.deleteTask('tsk-1');
  assert.equal(store.hasActiveBlocker('tsk-1', 'developer'), false);
  assert.deepEqual(store.listEvents('tsk-1'), []);
  db.close();
});

test('runner saturation keeps a task ready and a released slot wakes dispatch', async () => {
  let capacityAvailable = false;
  let signalStarted;
  const started = new Promise((resolve) => {
    signalStarted = resolve;
  });
  const { db, store, makeService } = fixture({
    hasFreeCapacity: () => capacityAvailable,
    createGoalRun: async () => {
      signalStarted();
      return { id: 'run-after-capacity', branch: 'task-branch' };
    },
  });
  insertTask(store);
  insertDeveloper(store);

  const service = makeService();
  await service.tick();
  assert.equal(store.getTask('tsk-1').status, 'ready');
  assert.equal(store.getTask('tsk-1').attempts, 0);
  assert.equal(store.getTask('tsk-1').assignedWorkerId, null);

  capacityAvailable = true;
  service.onRunChanged({ id: 'some-other-run', status: 'completed' });
  await started;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(store.getTask('tsk-1').status, 'in_progress');
  assert.equal(store.getTask('tsk-1').runId, 'run-after-capacity');
  assert.equal(store.getTask('tsk-1').attempts, 0);
  service.dispose();
  db.close();
});

test('a capacity race returns the task to ready without consuming an attempt', async () => {
  let capacityAvailable = true;
  const { db, store, makeService } = fixture({
    hasFreeCapacity: () => capacityAvailable,
    createGoalRun: async () => {
      capacityAvailable = false;
      throw new Error('runner slot disappeared');
    },
  });
  insertTask(store);
  insertDeveloper(store);

  const service = makeService();
  await service.tick();

  const task = store.getTask('tsk-1');
  assert.equal(task.status, 'ready');
  assert.equal(task.attempts, 0);
  assert.equal(task.assignedWorkerId, null);
  assert.equal(task.lastError, null);
  assert.equal(store.listEvents('tsk-1')[0].kind, 'waiting_for_runner');
  service.dispose();
  db.close();
});
