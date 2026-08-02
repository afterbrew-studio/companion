import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import { MAX_THREAD_REPLIES, reviewCommentTrigger, underReplyCap } from '../dist/api/review-replies.js';
import { PrReviewFindingsStore } from '../dist/api/pr-reviews-store.js';

const OURS = ['companion-agent', 'Acme-Maintainer'];

const comment = (fields) => ({
  id: 900,
  in_reply_to_id: 100,
  user: { login: 'author' },
  body: 'I think this is wrong.',
  ...fields,
});

// ---------- the loop ----------

test('a comment written by one of our own accounts never answers itself', () => {
  // The whole feature hinges on this: our replies come back as the same event,
  // so without it the agent argues with itself forever on a public PR.
  const decision = reviewCommentTrigger(comment({ user: { login: 'companion-agent' } }), OURS);
  assert.deepEqual(decision, { reply: false, refusal: 'own-comment' });
});

test('the login match is case-insensitive, because GitHub logins are', () => {
  const decision = reviewCommentTrigger(comment({ user: { login: 'ACME-maintainer' } }), OURS);
  assert.equal(decision.refusal, 'own-comment');
});

test('an app installation posts as [bot] under a login the registry never stored', () => {
  // The accounts registry keeps the account an app is INSTALLED ON, not the app
  // slug it comments as, so the login set alone cannot recognise our own posts.
  const decision = reviewCommentTrigger(comment({ user: { login: 'companion-ai[bot]' } }), OURS);
  assert.equal(decision.reply, false);
  assert.equal(decision.refusal, 'bot-comment');
});

// ---------- what is not a conversation ----------

test('a comment that is not a reply is ignored', () => {
  const decision = reviewCommentTrigger(comment({ in_reply_to_id: undefined }), OURS);
  assert.deepEqual(decision, { reply: false, refusal: 'not-a-reply' });
  assert.equal(reviewCommentTrigger(comment({ in_reply_to_id: null }), OURS).refusal, 'not-a-reply');
});

test('an empty reply is nothing to answer', () => {
  assert.equal(reviewCommentTrigger(comment({ body: '   \n ' }), OURS).refusal, 'empty');
});

test('a payload without an id or an author is refused rather than half-read', () => {
  assert.equal(reviewCommentTrigger(comment({ id: undefined }), OURS).refusal, 'malformed');
  assert.equal(reviewCommentTrigger(comment({ user: null }), OURS).refusal, 'malformed');
  assert.equal(reviewCommentTrigger(undefined, OURS).refusal, 'malformed');
});

test('a reply from the author carries the thread root, which is our own comment', () => {
  const decision = reviewCommentTrigger(comment(), OURS);
  assert.deepEqual(decision, {
    reply: true,
    trigger: { commentId: 900, rootId: 100, author: 'author', body: 'I think this is wrong.' },
  });
});

// ---------- someone else's thread ----------

test('a reply whose root is not one of our findings resolves to nothing', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE pr_review_findings (
      id TEXT PRIMARY KEY, review_id TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'native',
      file TEXT, side TEXT, line INTEGER, start_line INTEGER,
      severity TEXT NOT NULL DEFAULT 'minor', title TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '', impact TEXT NOT NULL DEFAULT '',
      suggestion TEXT NOT NULL DEFAULT '', suggested_patch TEXT,
      confidence REAL NOT NULL DEFAULT 0.5, state TEXT NOT NULL DEFAULT 'proposed',
      verification TEXT NOT NULL DEFAULT 'unverified', verification_note TEXT,
      rejection_reason TEXT, github_comment_id INTEGER, created_at INTEGER NOT NULL
    );
  `);
  const findings = new PrReviewFindingsStore(db);
  findings.insertMany([
    {
      id: 'prf-ours',
      reviewId: 'prr-1',
      source: 'native',
      anchor: { file: 'src/a.ts', side: 'RIGHT', line: 12, startLine: null },
      severity: 'major',
      title: 'Unbounded retry',
      reason: '',
      impact: '',
      suggestion: '',
      suggestedPatch: null,
      confidence: 0.9,
      state: 'posted',
      verification: 'confirmed',
      verificationNote: null,
      rejectionReason: null,
      githubCommentId: 100,
      createdAt: 1,
    },
  ]);

  const ours = reviewCommentTrigger(comment(), OURS);
  assert.equal(findings.findingByGithubCommentId(ours.trigger.rootId)?.id, 'prf-ours');

  // A thread another reviewer opened: nothing matches, so nothing is answered.
  const theirs = reviewCommentTrigger(comment({ in_reply_to_id: 555 }), OURS);
  assert.equal(findings.findingByGithubCommentId(theirs.trigger.rootId), undefined);
});

// ---------- the cap ----------

const thread = (n) =>
  Array.from({ length: n }, (_, i) => ({ id: 200 + i, in_reply_to_id: 100, user: { login: 'companion-agent' } }));

test('the agent stops after three replies in one thread', () => {
  const ourLogins = OURS;
  assert.equal(underReplyCap(thread(0), 100, ourLogins), true);
  assert.equal(underReplyCap(thread(MAX_THREAD_REPLIES - 1), 100, ourLogins), true);
  assert.equal(underReplyCap(thread(MAX_THREAD_REPLIES), 100, ourLogins), false);
  assert.equal(underReplyCap(thread(MAX_THREAD_REPLIES + 4), 100, ourLogins), false);
});

test('the root comment is the finding itself and is not counted as a reply', () => {
  const comments = [
    { id: 100, user: { login: 'companion-agent' } },
    { id: 201, in_reply_to_id: 100, user: { login: 'author' } },
  ];
  assert.equal(underReplyCap(comments, 100, OURS), true);
});

test('only the thread being answered counts toward its own cap', () => {
  const comments = [
    ...thread(MAX_THREAD_REPLIES).map((c) => ({ ...c, in_reply_to_id: 999 })),
    { id: 300, in_reply_to_id: 100, user: { login: 'author' } },
  ];
  assert.equal(underReplyCap(comments, 100, OURS), true, 'a busy neighbouring thread must not silence this one');
  assert.equal(underReplyCap(comments, 999, OURS), false);
});

test('replies the humans wrote do not spend the agent’s budget', () => {
  const comments = Array.from({ length: 9 }, (_, i) => ({
    id: 400 + i,
    in_reply_to_id: 100,
    user: { login: 'author' },
  }));
  assert.equal(underReplyCap(comments, 100, OURS), true);
});
