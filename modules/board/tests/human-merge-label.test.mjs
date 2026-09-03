import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, insertTask } from './fixture.mjs';

/**
 * A label that reserves the merge for a person is the last control standing
 * between the lane and a protected path: the reviewer has already approved and
 * the build is already green, so nothing else refuses. It was configurable,
 * stored and frozen onto the task, and read by nothing - an approved, green
 * change to an enforcement path merged itself.
 */
const approvedAndGreen = (labels) => ({
  pr: { state: 'open', draft: false, reviewDecision: 'approved', checks: null, headSha: 'head-1', labels },
  trySummary: async () => ({ state: 'passing', headSha: 'head-1' }),
});

const laneCard = (store, humanMergeLabels) =>
  insertTask(store, {
    status: 'in_review',
    stage: 'awaiting_review',
    prNumber: 17,
    prUrl: 'https://github.com/owner/repo/pull/17',
    automationPolicy: {
      autoReview: false,
      externalReviewLogin: 'octopus-ab[bot]',
      autoMerge: true,
      mergeMethod: 'squash',
      autoFixCi: false,
      maxAttempts: 3,
      humanMergeLabels,
    },
  });

/** Merging is the only thing that reaches for a credential on this path. */
const mergeSpy = () => {
  const calls = [];
  return {
    calls,
    performForRepo: async (_purpose, _repo, operation) => {
      calls.push('merge');
      const client = {
        pull: async () => ({ state: 'open', draft: false, head: { sha: 'head-1' } }),
        mergePr: async () => ({ merged: true, message: '' }),
        comment: async () => undefined,
        deleteMergedPrBranch: async () => undefined,
      };
      return { result: await operation(client), client, tried: [] };
    },
  };
};

test('a reserved label withholds the merge even when approved and green', async () => {
  const spy = mergeSpy();
  const { db, store, makeService } = fixture({
    ...approvedAndGreen(['P2', 'review:human']),
    performForRepo: spy.performForRepo,
  });
  laneCard(store, ['review:human', 'tier:human']);
  const service = makeService();

  await service.tick();
  service.dispose();

  assert.deepEqual(spy.calls, [], 'the lane must not merge a pull request reserved for a person');
  assert.equal(store.hasActiveBlocker('tsk-1', 'human_merge'), true, 'and must say why it stopped');
  db.close();
});

test('the same card merges once the reservation is not on it', async () => {
  // The guard: a gate that refused everything would satisfy the assertion above
  // just as happily, and would silently stop the lane merging anything at all.
  const spy = mergeSpy();
  const { db, store, makeService } = fixture({
    ...approvedAndGreen(['P2', 'area:governance']),
    performForRepo: spy.performForRepo,
  });
  laneCard(store, ['review:human', 'tier:human']);
  const service = makeService();

  await service.tick();
  service.dispose();

  assert.deepEqual(spy.calls, ['merge']);
  db.close();
});

test('the comparison is case-folded, so a hand-applied label still reserves', async () => {
  const spy = mergeSpy();
  const { db, store, makeService } = fixture({
    ...approvedAndGreen(['Review:Human']),
    performForRepo: spy.performForRepo,
  });
  laneCard(store, ['review:human']);
  const service = makeService();

  await service.tick();
  service.dispose();

  assert.deepEqual(spy.calls, []);
  db.close();
});

test('a flow that reserves nothing is unchanged', async () => {
  const spy = mergeSpy();
  const { db, store, makeService } = fixture({
    ...approvedAndGreen(['review:human']),
    performForRepo: spy.performForRepo,
  });
  laneCard(store, []);
  const service = makeService();

  await service.tick();
  service.dispose();

  assert.deepEqual(spy.calls, ['merge'], 'an empty list reserves nothing');
  db.close();
});
