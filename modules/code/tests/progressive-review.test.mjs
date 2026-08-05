import assert from 'node:assert/strict';
import test from 'node:test';
import { PrReviews } from '../dist/api/pr-reviews.js';

function finding(id, line, severity, verification = 'unverified') {
  return {
    id,
    reviewId: 'prr-progress',
    source: 'native',
    anchor: { file: 'src/example.ts', side: 'RIGHT', line, startLine: null },
    severity,
    title: `${severity} finding on line ${line}`,
    reason: 'The changed line can produce the wrong result.',
    impact: 'A caller observes incorrect behaviour.',
    suggestion: 'Handle the value before returning it.',
    suggestedPatch: null,
    confidence: 0.9,
    state: 'included',
    verification,
    verificationNote: null,
    rejectionReason: null,
    githubCommentId: null,
    createdAt: line,
  };
}

test('an explicitly-posting pipeline publishes safe shard findings now and serious findings after verification', async () => {
  const minor = finding('minor', 1, 'minor');
  const major = finding('major', 2, 'major');
  const staleAnchor = finding('stale-anchor', 99, 'minor');
  const stored = new Map([[minor.id, minor], [major.id, major], [staleAnchor.id, staleAnchor]]);
  const writes = [];
  let fileReads = 0;
  let commentReads = 0;
  const client = {
    prFiles: async () => {
      fileReads += 1;
      return {
        files: [{
          filename: 'src/example.ts',
          previous_filename: null,
          patch: '@@ -0,0 +1,2 @@\n+first changed line\n+second changed line',
        }],
      };
    },
    prReviewComments: async () => {
      commentReads += 1;
      return [];
    },
    pull: async () => ({ head: { sha: 'head-1' }, state: 'open', draft: false }),
    createPrReview: async (_repo, _number, input) => {
      writes.push(input);
      return { id: writes.length, html_url: `https://example.test/reviews/${writes.length}` };
    },
    prReviewCommentsFor: async (_repo, _number, reviewId) =>
      writes[reviewId - 1].comments.map((comment, index) => ({
        id: reviewId * 100 + index,
        path: comment.path,
        line: comment.line,
      })),
  };
  const reviews = new PrReviews(
    {
      prs: { get: () => ({ state: 'open', draft: false, headSha: 'head-1' }) },
      prReviews: { get: () => ({ status: 'running' }) },
      prReviewFindings: {
        get: (id) => stored.get(id),
        markPosted: (id, githubCommentId) => {
          stored.set(id, { ...stored.get(id), state: 'posted', githubCommentId });
        },
      },
    },
    {},
    {},
    () => null,
    () => 1_000,
    () => client,
    async () => ({ result: null, client: null, tried: [] }),
    {},
    () => true,
    () => undefined,
  );
  const result = {
    id: 'prr-progress',
    repo: 'acme/app',
    prNumber: 7,
    headSha: 'head-1',
  };

  const publisher = reviews.createProgressivePublisher(result, 'alice', 'full', true);
  await publisher.publish([minor, major, staleAnchor], { kind: 'chunk', completed: 1, total: 8 });
  await publisher.flush();

  assert.equal(writes.length, 1);
  assert.equal(writes[0].event, 'COMMENT');
  assert.equal(writes[0].comments.length, 1);
  assert.equal(writes[0].comments[0].line, 1);
  assert.match(writes[0].body, /group 1 of 8/);
  assert.equal(stored.get('minor').state, 'posted');
  assert.equal(stored.get('major').state, 'included');
  assert.equal(stored.get('stale-anchor').state, 'included', 'unverified GitHub anchors wait for the final review body');

  const confirmed = { ...stored.get('major'), verification: 'confirmed' };
  stored.set(confirmed.id, confirmed);
  await publisher.publish([confirmed], { kind: 'verification', completed: 1, total: 1 });
  await publisher.flush();

  assert.equal(writes.length, 2);
  assert.equal(writes[1].comments[0].line, 2);
  assert.match(writes[1].body, /verification 1 of 1/);
  assert.equal(stored.get('major').state, 'posted');
  assert.equal(fileReads, 1, 'the bounded PR diff is shared across shard publications');
  assert.equal(commentReads, 1, 'existing GitHub comments are read once per aggregate review');
});

test('summary-only pipelines do not construct a progressive publisher', () => {
  const reviews = new PrReviews(
    {},
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

  assert.equal(reviews.createProgressivePublisher({ repo: 'acme/app' }, 'alice', 'summary', true), null);
});
