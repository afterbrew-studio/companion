import assert from 'node:assert/strict';
import test from 'node:test';
import { PrReviews } from '../dist/api/pr-reviews.js';

/**
 * Only the collaborators `answerReviewerThreads` actually touches. Building a whole
 * PrReviews is neither possible here nor the point: the behaviour under test is which
 * threads it answers and in what order it gives up.
 */
function harness({ threads, replyFails = false, resolveFails = false, ourLogins = ['companion-afterbrew[bot]'] }) {
  const calls = { replied: [], resolved: [] };
  const client = {
    prReviewThreads: async () => ({ threads, truncated: false }),
    replyToReviewComment: async (_repo, _pr, commentId, body) => {
      if (replyFails) throw new Error('reply refused');
      calls.replied.push({ commentId, body });
      return { id: 1, html_url: 'u' };
    },
    resolveReviewThread: async (id) => {
      if (resolveFails) throw new Error('resolve refused');
      calls.resolved.push(id);
    },
  };
  const svc = Object.create(PrReviews.prototype);
  Object.defineProperty(svc, 'github', { value: () => client });
  Object.defineProperty(svc, 'store', { value: { githubAccounts: { logins: () => ourLogins } } });
  return { svc, calls };
}

const thread = (over = {}) => ({
  id: over.id ?? 'THREAD_1',
  isResolved: over.isResolved ?? false,
  isOutdated: false,
  path: 'README.md',
  line: 10,
  comments: { nodes: [{ id: 'C1', databaseId: 'databaseId' in over ? over.databaseId : 111, author: { login: over.author ?? 'octopus-afterbrew[bot]' }, body: 'finding', createdAt: '', url: '', path: 'README.md', line: 10 }] },
});

test('answers the reviewer thread and closes it', async () => {
  const { svc, calls } = harness({ threads: [thread()] });
  const out = await svc.answerReviewerThreads('o/r', 1, 'u', { body: 'addressed' });
  assert.deepEqual(out, { replied: 1, resolved: 1, failed: 0 });
  assert.equal(calls.replied[0].commentId, 111);
  assert.deepEqual(calls.resolved, ['THREAD_1']);
});

test('a thread we could not answer is not closed', async () => {
  // Resolving it would hide an objection that still has no reply.
  const { svc, calls } = harness({ threads: [thread()], replyFails: true });
  const out = await svc.answerReviewerThreads('o/r', 1, 'u', { body: 'addressed' });
  assert.equal(out.replied, 0);
  assert.equal(out.resolved, 0);
  assert.equal(out.failed, 1);
  assert.deepEqual(calls.resolved, [], 'must not resolve a thread it failed to reply to');
});

test('leaves our own threads alone', async () => {
  const { svc, calls } = harness({ threads: [thread({ author: 'companion-afterbrew[bot]' })] });
  const out = await svc.answerReviewerThreads('o/r', 1, 'u', { body: 'x' });
  assert.deepEqual(out, { replied: 0, resolved: 0, failed: 0 });
  assert.deepEqual(calls.replied, []);
});

test('leaves already-resolved threads alone', async () => {
  const { svc } = harness({ threads: [thread({ isResolved: true })] });
  const out = await svc.answerReviewerThreads('o/r', 1, 'u', { body: 'x' });
  assert.equal(out.replied, 0);
});

test('honours a named reviewer when one is given', async () => {
  const { svc } = harness({ threads: [thread({ author: 'someone-else' })] });
  const named = await svc.answerReviewerThreads('o/r', 1, 'u', { body: 'x', reviewerLogin: 'octopus-afterbrew[bot]' });
  assert.equal(named.replied, 0, 'a different reviewer is skipped when one is named');
  const anyone = await svc.answerReviewerThreads('o/r', 1, 'u', { body: 'x' });
  assert.equal(anyone.replied, 1, 'with none named, anyone waiting gets an answer');
});

test('a thread with no REST id is skipped rather than half-handled', async () => {
  const { svc, calls } = harness({ threads: [thread({ databaseId: null })] });
  const out = await svc.answerReviewerThreads('o/r', 1, 'u', { body: 'x' });
  assert.deepEqual(out, { replied: 0, resolved: 0, failed: 0 });
  assert.deepEqual(calls.resolved, []);
});

test('one bad thread does not stop the rest', async () => {
  const good = thread({ id: 'T2', databaseId: 222 });
  const skip = thread({ id: 'T3', databaseId: null });
  const { svc, calls } = harness({ threads: [skip, good] });
  const out = await svc.answerReviewerThreads('o/r', 1, 'u', { body: 'x' });
  assert.equal(out.replied, 1);
  assert.deepEqual(calls.resolved, ['T2']);
});
