import assert from 'node:assert/strict';
import test from 'node:test';
import { Triage } from '../dist/api/triage.js';

/**
 * Only the collaborators `apply` touches. The behaviour under test is which labels reach
 * GitHub, and `addLabels` CREATES anything it is given -- so a label the model invented
 * becomes a real, permanent label on somebody's repository.
 */
function harness({ verdict, defined, labelsThrow = false }) {
  const calls = { added: [], comments: [] };
  const client = {
    repoLabels: async () => {
      if (labelsThrow) throw new Error('GitHub is unreachable');
      return defined;
    },
    addLabels: async (_repo, _issue, labels) => calls.added.push(...labels),
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
  assert.deepEqual(calls.added, []);
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
