import assert from 'node:assert/strict';
import test from 'node:test';
import { Triage } from '../dist/api/triage.js';

/**
 * Only the collaborators `apply` touches. The behaviour under test is which labels reach
 * GitHub, and `addLabels` CREATES anything it is given -- so a label the model invented
 * becomes a real, permanent label on somebody's repository.
 */
function harness({ verdict, defined, labelsThrow = false, truncated = false }) {
  const calls = { added: [], comments: [], addLabelsCalls: 0 };
  const client = {
    repoLabels: async () => {
      if (labelsThrow) throw new Error('GitHub is unreachable');
      return { labels: defined, truncated };
    },
    addLabels: async (_repo, _issue, labels) => {
      calls.addLabelsCalls += 1;
      calls.added.push(...labels);
    },
    comment: async (_repo, _issue, body) => calls.comments.push(body),
  };
  const result = {
    id: 't1',
    repo: 'owner/name',
    issueNumber: 7,
    status: 'pending',
    verdict: { labels: [], duplicateOf: null, needsInfo: false, draftReply: '', ...verdict },
  };
  const svc = Object.create(Triage.prototype);
  Object.defineProperty(svc, 'github', { value: () => client });
  Object.defineProperty(svc, 'store', {
    value: { triage: { get: () => result, update: () => {} } },
  });
  Object.defineProperty(svc, 'broadcast', { value: () => {} });
  Object.defineProperty(svc, 'requireAuthority', { value: () => {} });
  return { svc, calls };
}

const apply = (svc) => svc.apply('t1', { comment: false, userId: 'u1' });

test('applies only labels the repository defines', async () => {
  const { svc, calls } = harness({
    verdict: { labels: ['area:ci', 'agent-ready'] },
    defined: ['area:ci', 'agent:ready'],
  });
  await apply(svc);
  // `agent-ready` is the kebab spelling of `agent:ready`. Plausible, wrong, and previously
  // created as a second real label that then had to be deleted by hand.
  assert.deepEqual(calls.added, ['area:ci']);
});

test('does not create duplicate or needs-info on a repository that lacks them', async () => {
  const { svc, calls } = harness({
    verdict: { labels: [], duplicateOf: 12, needsInfo: true },
    defined: ['area:ci'],
  });
  await apply(svc);
  assert.deepEqual(calls.added, []);
});

test('applies duplicate and needs-info where the repository does define them', async () => {
  const { svc, calls } = harness({
    verdict: { labels: [], duplicateOf: 12, needsInfo: true },
    defined: ['duplicate', 'needs-info'],
  });
  await apply(svc);
  assert.deepEqual(calls.added.sort(), ['duplicate', 'needs-info']);
});

test('makes no GitHub call when nothing survives the filter', async () => {
  const { svc, calls } = harness({ verdict: { labels: ['invented'] }, defined: ['area:ci'] });
  await apply(svc);
  // The call COUNT, not just the result: asserting an empty array passes whether addLabels
  // was never called or was called with nothing, so removing the guard would not fail it.
  assert.equal(calls.addLabelsCalls, 0);
  assert.deepEqual(calls.added, []);
});

test('a repository with no labels at all filters everything out', async () => {
  // Not an outage - a permanent, legitimate state for a repository that deleted GitHub's
  // defaults. Reading it as "no catalogue" reproduced the bug this filtering prevents.
  const { svc, calls } = harness({ verdict: { labels: ['invented'] }, defined: [] });
  await apply(svc);
  assert.equal(calls.addLabelsCalls, 0);
});

test('a truncated label list does not filter against a partial catalogue', async () => {
  // Filtering against page 1-3 of a longer list would strip legitimate labels and log them
  // identically to invented ones. Unreadable is the honest answer.
  const { svc, calls } = harness({
    verdict: { labels: ['area:ci'] },
    defined: ['something-else'],
    truncated: true,
  });
  await apply(svc);
  assert.deepEqual(calls.added, ['area:ci']);
});

test('an unreadable label list degrades to applying what was proposed', async () => {
  // Deliberate: a GitHub outage must not silently stop triage labelling anything. The
  // alternative failure - an invented label - is one a human sees on the Apply screen first.
  const { svc, calls } = harness({ verdict: { labels: ['area:ci'] }, defined: [], labelsThrow: true });
  await apply(svc);
  assert.deepEqual(calls.added, ['area:ci']);
});

test('deduplicates before applying', async () => {
  const { svc, calls } = harness({
    verdict: { labels: ['area:ci', 'area:ci'] },
    defined: ['area:ci'],
  });
  await apply(svc);
  assert.deepEqual(calls.added, ['area:ci']);
});
