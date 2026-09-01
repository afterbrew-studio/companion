import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, insertTask } from './fixture.mjs';

test('unrecoverable ancestor opens a successor PR instead of looping fix_ci', async () => {
  const reopened = [];
  const { db, store, dispatched, makeService } = fixture({
    latestReview: {
      source: 'agent',
      status: 'applied',
      headSha: 'head-1',
      error: null,
      coverage: { state: 'complete' },
      findings: [],
      verdict: { recommendation: 'approve', risk: 'low' },
    },
    trySummary: async () => ({ state: 'failing', headSha: 'head-1' }),
    reopenCleanHistory: async (repo, oldPr, username, reason) => {
      reopened.push({ repo, oldPr, username, reason });
      return { prUrl: 'https://github.com/owner/repo/pull/99', prNumber: 99 };
    },
  });
  insertTask(store, {
    id: 'tsk-1',
    status: 'in_review',
    stage: 'awaiting_merge',
    prNumber: 17,
    prUrl: 'https://github.com/owner/repo/pull/17',
    createdBy: 'owner-profile',
  });

  await makeService().tick();

  const task = store.getTask('tsk-1');
  assert.equal(task.prNumber, 99, 'the card must move onto the successor');
  assert.equal(task.stage, 'awaiting_review');
  assert.notEqual(task.stage, 'fix_ci', 'fix_ci would loop on an unrecoverable ancestor');
  assert.equal(dispatched.length, 0, 'a successor must not start another CI-repair run');
  assert.equal(reopened.length, 1);
  assert.equal(reopened[0].oldPr, 17);
  db.close();
});
