import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, insertTask, insertDeveloper } from './fixture.mjs';

const lanePolicy = {
  autoReview: false,
  externalReviewLogin: 'octopus-ab[bot]',
  autoMerge: false,
  mergeMethod: 'squash',
  autoFixCi: false,
  maxAttempts: 3,
  humanMergeLabels: [],
};

/**
 * Octopus refuses to review a pull request whose checks are failing and does
 * not come back on its own. The board recorded the request and then waited on a
 * decision that refusal guaranteed would never arrive: an approved-looking,
 * green pull request with no reviewer, stalled indefinitely.
 */
test('a decline made while checks were red is re-asked once they pass', async () => {
  const started = [];
  const { db, store, makeService } = fixture({
    pr: { state: 'open', draft: false, reviewDecision: null, checks: null, headSha: 'head-1', labels: [] },
    trySummary: async () => ({ state: 'passing', headSha: 'head-1' }),
    performForRepo: async (_purpose, _repo, operation) => {
      started.push('checkRuns');
      const client = {
        checkRuns: async () => [
          { name: 'Octopus Review', status: 'completed', conclusion: 'neutral' },
        ],
      };
      return { result: await operation(client), client, tried: [] };
    },
  });
  insertTask(store, {
    status: 'in_review',
    stage: 'awaiting_review',
    prNumber: 21,
    prUrl: 'https://example.test/pr/21',
    automationPolicy: lanePolicy,
  });
  store.insertEvent('tsk-1', 'review_requested', 'octopus adapter abc for owner/repo#21 at head-1');

  const service = makeService();
  await service.tick();
  await new Promise((resolve) => setTimeout(resolve, 300));
  service.dispose();

  const kinds = store.listEvents('tsk-1').map((e) => e.kind);
  assert.ok(kinds.includes('review_stale'), `expected a re-ask, saw ${kinds.join(',')}`);
  db.close();
});

test('a decline while the checks are still red is left alone', async () => {
  // The guard: re-asking a reviewer that is correctly refusing would loop.
  const { db, store, makeService } = fixture({
    pr: { state: 'open', draft: false, reviewDecision: null, checks: null, headSha: 'head-1', labels: [] },
    trySummary: async () => ({ state: 'failing', headSha: 'head-1' }),
    performForRepo: async (_purpose, _repo, operation) => {
      const client = {
        checkRuns: async () => [
          { name: 'Octopus Review', status: 'completed', conclusion: 'neutral' },
        ],
      };
      return { result: await operation(client), client, tried: [] };
    },
  });
  insertTask(store, {
    status: 'in_review',
    stage: 'awaiting_review',
    prNumber: 21,
    prUrl: 'https://example.test/pr/21',
    automationPolicy: lanePolicy,
  });
  store.insertEvent('tsk-1', 'review_requested', 'octopus adapter abc for owner/repo#21 at head-1');

  const service = makeService();
  await service.tick();
  await new Promise((resolve) => setTimeout(resolve, 300));
  service.dispose();

  const kinds = store.listEvents('tsk-1').map((e) => e.kind);
  assert.ok(!kinds.includes('review_stale'), 'a reviewer refusing a red build must not be re-asked');
  db.close();
});

test('a review is asked again when the head moves', () => {
  const { db, store, makeService } = fixture();
  insertTask(store, { status: 'in_review', stage: 'awaiting_review', prNumber: 21 });
  store.insertEvent('tsk-1', 'review_requested', 'octopus adapter abc for owner/repo#21 at head-1');
  const service = makeService();

  // Reaching through the instance keeps the assertion on the real predicate
  // rather than a copy of its rule.
  const task = store.getTask('tsk-1');
  const startedFor = (sha) => service.constructor.prototype.octopusStartedFor.call(service, task, 21, sha);
  assert.equal(startedFor('head-1'), true, 'the reviewed commit counts as started');
  assert.equal(startedFor('head-2'), false, 'a repaired commit has not been reviewed');

  service.dispose();
  db.close();
});

/**
 * A card burned its whole attempt budget "repairing" a GitHub API timeout it
 * could not fix, and landed in Failed with nothing wrong in its diff. The
 * reviewer path already refuses to charge its budget for its own
 * infrastructure; a worker run is no different.
 */
const failingRun = (reason) => ({
  createGoalRun: async () => {
    throw new Error(reason);
  },
});

async function dispatchAndFail(reason) {
  const { db, store, makeService } = fixture(failingRun(reason));
  insertTask(store, { status: 'ready', stage: 'build' });
  insertDeveloper(store);
  const service = makeService();
  await service.tick();
  await new Promise((resolve) => setTimeout(resolve, 150));
  const task = store.getTask('tsk-1');
  service.dispose();
  db.close();
  return task;
}

test('a provider outage does not spend one of the card attempts', async () => {
  const task = await dispatchAndFail('fatal: provider kept returning a retryable error 6 times in a row (last: 429)');
  assert.equal(task.attempts, 0, 'infrastructure is not the card being wrong');
  assert.notEqual(task.status, 'failed');
});

test('a transport failure does not spend one either', async () => {
  const task = await dispatchAndFail('fatal: Premature close');
  assert.equal(task.attempts, 0);
});

test('a failure that is the card own still spends an attempt', async () => {
  // The guard: an allowance that swallowed every failure would make maxAttempts
  // meaningless and let a genuinely broken card retry forever.
  const task = await dispatchAndFail('the patch did not apply');
  assert.equal(task.attempts, 1);
});

/**
 * A card in review learns its pull request's fate from a webhook and nothing
 * else, so an event that arrives while the daemon is down is gone: the cached
 * row still says `open` and the card waits on a pull request closed days ago.
 * Measured at five days, against a pull request closed while the host rebooted.
 */
test('a card re-reads its pull request once per daemon life', async () => {
  const asked = [];
  const { db, store, makeService } = fixture({
    syncPr: async (repo, number) => {
      asked.push(`${repo}#${number}`);
    },
  });
  insertTask(store, { status: 'in_review', stage: 'awaiting_review', prNumber: 21 });
  const service = makeService();

  await service.tick();
  await service.tick();
  await service.tick();
  service.dispose();

  // Once, not per tick: the webhook is the live path and this only covers the
  // window where nothing was listening.
  assert.deepEqual(asked, ['owner/repo#21']);
  db.close();
});

test('a card with no pull request is not re-read', async () => {
  const asked = [];
  const { db, store, makeService } = fixture({
    syncPr: async (repo, number) => {
      asked.push(`${repo}#${number}`);
    },
  });
  insertTask(store, { status: 'ready', stage: 'build' });
  const service = makeService();
  await service.tick();
  service.dispose();

  assert.deepEqual(asked, []);
  db.close();
});

/**
 * `activeCountsByRunner` counts `review` towards a runner's capacity, rightly:
 * a run awaiting a decision outlives its gateway. But once the card has moved
 * on, nothing will ever advance that run and it holds its slot for good. Three
 * of them silenced the whole lane - `max_runs` is 3, so capacity was zero and
 * every card sat `ready` while the oldest ghost had been dead twelve days.
 */
test('a board run no card claims gives its slot back', async () => {
  const { db, store, makeService, reclaimed } = fixture({
    activeOwned: [
      { id: 'run-ghost', task: 'board.worker', status: 'review' },
      { id: 'run-mine', task: 'board.worker', status: 'running' },
    ],
    // The claimed run has to exist as a row too, or `recoverDangling` requeues
    // its card for a lost run before the sweep is reached - which would leave
    // the run unclaimed and pass this test for the wrong reason.
    runRows: { 'run-mine': { id: 'run-mine', status: 'running' } },
  });
  insertTask(store, { status: 'in_progress', stage: 'build', runId: 'run-mine' });
  const service = makeService();
  await service.tick();
  service.dispose();

  // A Set, because reclaiming frees a slot and so kicks a follow-up pass; the
  // question is which runs were touched, not how many times.
  assert.deepEqual(
    [...new Set(reclaimed.map((r) => r.id))],
    ['run-ghost'],
    'the claimed run keeps its slot',
  );
  assert.equal(reclaimed[0].status, 'abandoned');
  db.close();
});

test('a run belonging to another feature is left alone', async () => {
  // The guard: the board must not reclaim slots it does not own. A chat or a
  // triage run has no card by design and is not a leak.
  const { db, store, makeService, reclaimed } = fixture({
    activeOwned: [
      { id: 'run-chat', task: 'operate.chat', status: 'idle' },
      { id: 'run-triage', task: 'code.triage', status: 'running' },
    ],
  });
  const service = makeService();
  await service.tick();
  service.dispose();

  assert.deepEqual(reclaimed, [], 'only board.worker runs are the board to reclaim');
  db.close();
});
