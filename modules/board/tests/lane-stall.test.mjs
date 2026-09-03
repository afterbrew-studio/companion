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
