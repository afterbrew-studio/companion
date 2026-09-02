import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, insertTask } from './fixture.mjs';

/** `octopusDeclined` is dispatched, not awaited, by the review cycle. */
const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise((resolve) => setImmediate(resolve));
};

/**
 * ADR-0088: a `neutral` conclusion on the `Octopus Review` check means Octopus did NOT
 * review - automatic review off, a draft, a blocked author - not that it reviewed and found
 * nothing. Nothing read that check, so a declined review and a slow one were the same thing
 * to the board, and the card waited in `awaiting_review` for a review that was never coming.
 */

const laneTask = (store) =>
  insertTask(store, {
    status: 'in_review',
    stage: 'awaiting_review',
    prNumber: 14,
    prUrl: 'https://example.test/pr/14',
    automationPolicy: { autoReview: false, autoMerge: false, mergeMethod: 'merge', autoFixCi: false, maxAttempts: 3 },
  });

/** The adapter already ran, which is what stops the cycle starting another one. */
const alreadyStarted = (store) =>
  store.insertEvent('tsk-1', 'review_requested', 'octopus adapter corr-1 for owner/repo#14');

const checkRuns = (runs) => async (_purpose, _repo, action) => ({
  result: await action({ checkRuns: async () => runs }),
  client: null,
  tried: [],
});

test('a neutral Octopus check blocks the card instead of waiting forever', async () => {
  const { db, store, makeService } = fixture({
    pr: { state: 'open', reviewDecision: null, checks: null, headSha: 'head-1' },
    performForRepo: checkRuns([{ name: 'Octopus Review', status: 'completed', conclusion: 'neutral' }]),
  });
  laneTask(store);
  alreadyStarted(store);

  const service = makeService();
  await service.tick();
  await settle();
  service.dispose();

  assert.equal(store.hasActiveBlocker('tsk-1', 'octopus_declined'), true);
  db.close();
});

test('a successful Octopus check is not a decline', async () => {
  const { db, store, makeService } = fixture({
    pr: { state: 'open', reviewDecision: null, checks: null, headSha: 'head-1' },
    performForRepo: checkRuns([{ name: 'Octopus Review', status: 'completed', conclusion: 'success' }]),
  });
  laneTask(store);
  alreadyStarted(store);

  const service = makeService();
  await service.tick();
  await settle();
  service.dispose();

  assert.equal(store.hasActiveBlocker('tsk-1', 'octopus_declined'), false);
  db.close();
});

test('only the latest run counts, so the refusal that precedes a lane review is not a decline', async () => {
  // A lane pull request collects two checks: `pull_request opened` is refused upstream and
  // posts `neutral`, then the adapter starts the real review. Reading any run rather than
  // the last would call every lane review declined on the strength of that first refusal.
  const { db, store, makeService } = fixture({
    pr: { state: 'open', reviewDecision: null, checks: null, headSha: 'head-1' },
    performForRepo: checkRuns([
      { name: 'Octopus Review', status: 'completed', conclusion: 'neutral' },
      { name: 'Octopus Review', status: 'completed', conclusion: 'success' },
    ]),
  });
  laneTask(store);
  alreadyStarted(store);

  const service = makeService();
  await service.tick();
  await settle();
  service.dispose();

  assert.equal(store.hasActiveBlocker('tsk-1', 'octopus_declined'), false);
  db.close();
});

test('an unreadable check run is not reported as a decline', async () => {
  // Saying "Octopus declined" because GitHub was briefly unreachable sends someone to
  // look at the wrong system.
  const { db, store, makeService } = fixture({
    pr: { state: 'open', reviewDecision: null, checks: null, headSha: 'head-1' },
    performForRepo: async () => {
      throw new Error('github unreachable');
    },
  });
  laneTask(store);
  alreadyStarted(store);

  const service = makeService();
  await service.tick();
  await settle();
  service.dispose();

  assert.equal(store.hasActiveBlocker('tsk-1', 'octopus_declined'), false);
  db.close();
});
