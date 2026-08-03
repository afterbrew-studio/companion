import assert from 'node:assert/strict';
import test from 'node:test';
import { PrReviews } from '../dist/api/pr-reviews.js';

const result = Object.freeze({
  id: 'prr-gate',
  repo: 'acme/app',
  prNumber: 9,
  source: 'agent',
  status: 'pending',
  verdict: {
    summary: 'Safe focused change',
    risk: 'low',
    recommendation: 'approve',
    reviewBody: 'No material concerns.',
  },
  error: null,
  coverage: {
    state: 'complete',
    reviewedGroups: 2,
    totalGroups: 2,
    reviewedFiles: 4,
    totalFiles: 4,
    unread: [],
  },
  headSha: 'head-9',
  findings: [
    {
      id: 'finding-confirmed',
      severity: 'blocker',
      verification: 'confirmed',
      confidence: 0.95,
    },
    {
      id: 'finding-unverified',
      severity: 'blocker',
      verification: 'unverified',
      confidence: 0.99,
    },
  ],
});

function fixture() {
  const pr = {
    headSha: 'head-9',
    state: 'open',
    draft: false,
    checks: { state: 'pending', runs: [], fetchedAt: 1 },
  };
  const reviews = new PrReviews(
    { prs: { get: () => pr } },
    {},
    {},
    () => null,
    () => 1_000,
    () => null,
    async () => ({ result: null, client: null, tried: [] }),
    {},
    () => true,
    () => undefined,
  );
  const applied = [];
  reviews.apply = async (...args) => {
    applied.push(args);
    return { repo: 'acme/app', number: 9 };
  };
  return { pr, reviews, applied };
}

test('a completed gate waits for CI, then publishes the same head-pinned evidence', async () => {
  const { pr, reviews, applied } = fixture();

  assert.equal(await reviews.publishPendingGate('acme/app', 9, 'alice', result), false);
  assert.equal(applied.length, 0);

  pr.checks = { ...pr.checks, state: 'passing' };
  assert.equal(await reviews.publishPendingGate('acme/app', 9, 'alice', result), true);
  assert.deepEqual(applied, [
    [
      result.id,
      {
        userId: 'alice',
        findingIds: ['finding-confirmed'],
        mode: 'comments',
        eventOverride: 'COMMENT',
      },
    ],
  ]);
});

test('a new head invalidates a pending gate instead of posting stale anchors', async () => {
  const { pr, reviews, applied } = fixture();
  pr.headSha = 'head-10';
  pr.checks = { ...pr.checks, state: 'passing' };

  assert.equal(await reviews.publishPendingGate('acme/app', 9, 'alice', result), false);
  assert.equal(applied.length, 0);
});

test('unverified or already-posted findings never cause repeated unattended reviews', async () => {
  const { pr, reviews, applied } = fixture();
  pr.checks = { ...pr.checks, state: 'passing' };

  const withheld = {
    ...result,
    findings: [{ ...result.findings[1], state: 'included' }],
  };
  assert.equal(await reviews.publishPendingGate('acme/app', 9, 'alice', withheld), false);

  const replay = {
    ...result,
    findings: [
      { ...result.findings[0], state: 'posted' },
      { ...result.findings[1], state: 'included' },
    ],
  };
  assert.equal(await reviews.publishPendingGate('acme/app', 9, 'alice', replay), false);
  assert.equal(applied.length, 0);
});

function applyFixture({ liveHead = 'head-9', authorized = () => true } = {}) {
  const writes = [];
  const updates = [];
  const client = {
    prFiles: async () => ({ files: [] }),
    prReviewComments: async () => [],
    pull: async () => ({ head: { sha: liveHead }, state: 'open', draft: false }),
    createPrReview: async (_repo, _number, input) => {
      writes.push(input);
      return { id: 77, html_url: 'https://example.test/review/77' };
    },
    prReviewCommentsFor: async () => [],
  };
  const reviews = new PrReviews(
    {
      prs: { get: () => ({ state: 'open', draft: false, headSha: 'head-9' }) },
      prReviews: {
        get: () => ({ ...result, findings: [] }),
        update: (...args) => updates.push(args),
      },
      prReviewFindings: {
        listForReview: () => [],
        markPosted: () => undefined,
      },
    },
    {},
    {},
    () => null,
    () => 1_000,
    () => client,
    async () => ({ result: null, client: null, tried: [] }),
    {},
    authorized,
    () => undefined,
  );
  return { reviews, writes, updates };
}

test('review publication refuses a force-pushed head immediately before the GitHub write', async () => {
  const { reviews, writes, updates } = applyFixture({ liveHead: 'head-10' });

  await assert.rejects(
    reviews.apply(result.id, { userId: 'alice', findingIds: [], eventOverride: 'COMMENT' }),
    /new commits since the review ran/,
  );
  assert.deepEqual(writes, []);
  assert.deepEqual(updates, []);
});

test('review publication refuses authority revoked while evidence was prepared', async () => {
  let checks = 0;
  const { reviews, writes, updates } = applyFixture({
    authorized: () => ++checks === 1,
  });

  await assert.rejects(
    reviews.apply(result.id, { userId: 'alice', findingIds: [], eventOverride: 'COMMENT' }),
    /no longer holds prs:act/,
  );
  assert.equal(checks, 2);
  assert.deepEqual(writes, []);
  assert.deepEqual(updates, []);
});
