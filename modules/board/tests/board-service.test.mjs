import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, insertDeveloper, insertTask } from './fixture.mjs';

test('board list query is scoped in SQLite before rows from another workspace are materialized', () => {
  const { db, store } = fixture();
  insertTask(store, { id: 'tsk-one', workspaceId: 'ws-1', title: 'Workspace one' });
  insertTask(store, { id: 'tsk-two', workspaceId: 'ws-2', title: 'Workspace two' });

  assert.deepEqual(store.listTasks('ws-1').map((task) => task.id), ['tsk-one']);
  assert.deepEqual(store.listTasks('ws-2').map((task) => task.id), ['tsk-two']);
  db.close();
});

test('board keeps active work complete while paging the Done archive by repository', () => {
  const { db, store } = fixture();
  insertTask(store, { id: 'active-other', repo: 'owner/other', status: 'ready', createdAt: 10, updatedAt: 10 });
  for (let index = 0; index < 230; index += 1) {
    insertTask(store, {
      id: `done-${String(index).padStart(3, '0')}`,
      status: 'done',
      stage: null,
      createdAt: index,
      updatedAt: index,
      finishedAt: index,
    });
  }
  insertTask(store, {
    id: 'done-other-repo', repo: 'owner/other', status: 'done', stage: null,
    createdAt: 999, updatedAt: 999, finishedAt: 999,
  });

  const middle = store.listBoardTasks('ws-1', { doneRepo: 'owner/repo', doneLimit: 100, doneOffset: 100 });
  assert.equal(middle.doneTotal, 230);
  assert.equal(middle.doneOffset, 100);
  assert.equal(middle.tasks.filter((task) => task.status !== 'done').length, 1);
  assert.equal(middle.tasks.filter((task) => task.status === 'done').length, 100);
  assert.equal(middle.tasks.find((task) => task.status === 'done').id, 'done-129');
  assert.deepEqual(middle.taskRepos, ['owner/other', 'owner/repo']);

  const final = store.listBoardTasks('ws-1', { doneRepo: 'owner/repo', doneLimit: 100, doneOffset: 999_999 });
  assert.equal(final.doneOffset, 200);
  assert.equal(final.tasks.filter((task) => task.status === 'done').length, 30);
  assert.equal(final.tasks.at(-1).id, 'done-000');
  db.close();
});

test('board cards omit long authoring fields and attachment bodies', () => {
  const { db, store, makeService } = fixture();
  insertTask(store, {
    description: 'd'.repeat(20_000),
    acceptance: 'a'.repeat(10_000),
    attachments: [{ name: 'evidence.png', mediaType: 'image/png', content: 'base64-body' }],
  });

  const snapshot = makeService().listBoard({ username: 'alice' }, 'ws-1');
  assert.equal(snapshot.tasks.length, 1);
  assert.equal(Object.hasOwn(snapshot.tasks[0], 'description'), false);
  assert.equal(Object.hasOwn(snapshot.tasks[0], 'acceptance'), false);
  assert.equal(snapshot.tasks[0].attachments[0].content, null);
  db.close();
});

test('decision context is bounded and retains active ownership links', () => {
  const { db, store, makeService } = fixture();
  for (let index = 0; index < 205; index += 1) {
    insertTask(store, {
      id: `failed-${String(index).padStart(3, '0')}`,
      status: 'failed',
      stage: null,
      createdAt: index,
      updatedAt: index,
    });
  }
  insertTask(store, { id: 'linked-run', runId: 'run-review', status: 'in_progress' });
  insertTask(store, { id: 'linked-pr', prNumber: 42, status: 'in_review', stage: 'reviewing' });
  insertTask(store, { id: 'done-link', runId: 'run-done', status: 'done', stage: null });

  const snapshot = makeService().listDecisionContext(
    { username: 'alice' },
    'ws-1',
    {
      runIds: ['run-review', 'run-done'],
      pullRequests: [{ repo: 'owner/repo', number: 42 }],
    },
    200,
  );

  assert.equal(snapshot.hasMore, true);
  assert.equal(snapshot.tasks.filter((task) => task.status === 'failed').length, 200);
  assert.equal(snapshot.tasks.some((task) => task.id === 'linked-run'), true);
  assert.equal(snapshot.tasks.some((task) => task.id === 'linked-pr'), true);
  assert.equal(snapshot.tasks.some((task) => task.id === 'done-link'), false);
  db.close();
});

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

test('a current pending review waits for human publication instead of running again', async () => {
  const latestReview = {
    source: 'agent',
    status: 'pending',
    headSha: 'head-1',
    error: null,
    coverage: { state: 'complete' },
    verdict: { recommendation: 'approve' },
  };
  const { db, store, notifications, makeService } = fixture({ latestReview });
  insertTask(store, {
    status: 'in_review',
    stage: 'awaiting_merge',
    prNumber: 14,
    prUrl: 'https://example.test/pr/14',
    reviewRisk: 'low',
    reviewRecommendation: 'approve',
  });

  const service = makeService();
  await service.tick();

  assert.equal(store.getTask('tsk-1').stage, 'awaiting_merge');
  assert.equal(store.listEvents('tsk-1').some((event) => event.kind === 'review_stale'), false);
  assert.equal(notifications.length, 0);
  service.dispose();
  db.close();
});

test('a manually published request-changes review resumes remediation', async () => {
  const latestReview = {
    source: 'agent',
    status: 'applied',
    headSha: 'head-1',
    error: null,
    coverage: { state: 'complete' },
    verdict: { recommendation: 'request_changes' },
  };
  const { db, store, makeService } = fixture({ latestReview });
  insertTask(store, {
    status: 'in_review',
    stage: 'awaiting_merge',
    prNumber: 14,
    prUrl: 'https://example.test/pr/14',
    reviewRisk: 'high',
    reviewRecommendation: 'request_changes',
  });

  const service = makeService();
  await service.tick();

  const task = store.getTask('tsk-1');
  assert.equal(task.status, 'ready');
  assert.equal(task.stage, 'address_review');
  assert.equal(task.attempts, 1);
  assert.equal(store.listEvents('tsk-1').some((event) => event.kind === 'changes_requested'), true);
  service.dispose();
  await new Promise((resolve) => setImmediate(resolve));
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

test('CI repair does not spend the budget a reviewer objection will need', async () => {
  // rayf#304 and #315: one counter served both, so a flaky check exhausted the ceiling and
  // the card failed with the reviewer's objection unaddressed. Two failures that are not
  // the same failure do not share a ceiling.
  const latestReview = {
    source: 'agent',
    status: 'applied',
    headSha: 'head-1',
    error: null,
    coverage: { state: 'complete' },
    verdict: { recommendation: 'request_changes' },
  };
  const { store, makeService } = fixture({ latestReview });
  insertTask(store, {
    status: 'in_review',
    stage: 'awaiting_merge',
    prNumber: 14,
    prUrl: 'https://example.test/pr/14',
    reviewRisk: 'high',
    reviewRecommendation: 'request_changes',
    // Three CI repairs already spent — the whole ceiling, on the other budget.
    ciAttempts: 3,
    attempts: 3,
  });

  const service = makeService();
  await service.tick();

  const task = store.getTask('tsk-1');
  assert.equal(task.stage, 'address_review', 'remediation still has its own budget');
  assert.equal(task.reviewAttempts, 1);
  assert.equal(task.ciAttempts, 3, 'the CI counter is untouched by a review cycle');
  assert.notEqual(task.status, 'failed');
  service.dispose();
});

test('the review budget still has a ceiling of its own', async () => {
  const latestReview = {
    source: 'agent',
    status: 'applied',
    headSha: 'head-1',
    error: null,
    coverage: { state: 'complete' },
    verdict: { recommendation: 'request_changes' },
  };
  const { store, makeService } = fixture({ latestReview });
  insertTask(store, {
    status: 'in_review',
    stage: 'awaiting_merge',
    prNumber: 14,
    prUrl: 'https://example.test/pr/14',
    reviewRisk: 'high',
    reviewRecommendation: 'request_changes',
    reviewAttempts: 3,
  });

  const service = makeService();
  await service.tick();

  const task = store.getTask('tsk-1');
  assert.equal(task.status, 'failed', 'separate budgets are still bounded, not unlimited');
  assert.match(task.lastError ?? '', /review remediation ceiling/);
  service.dispose();
});
