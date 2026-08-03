import assert from 'node:assert/strict';
import test from 'node:test';
import { ReviewChat } from '../dist/api/review-chat.js';

function fixture() {
  const settings = new Map();
  const runs = new Map();
  let sequence = 0;
  const store = {
    settings: {
      get: (key) => settings.get(key) ?? null,
      set: (key, value) => settings.set(key, value),
    },
    prReviews: {
      get: () => ({ id: 'review-1', repo: 'acme/app', prNumber: 7 }),
    },
    prReviewFindings: { listForReview: () => [] },
    prs: { get: () => ({ baseRef: 'main' }) },
  };
  const orchestrator = {
    createRun: async (input) => {
      const run = {
        id: `chat-${++sequence}`,
        userId: input.userId,
        repo: input.repo,
        status: 'running',
        live: true,
      };
      runs.set(run.id, run);
      return run;
    },
    getRun: (id) => runs.get(id),
    sendPrompt: async () => ({ turnId: `turn-${sequence}` }),
    loadHistory: async (id) => ({ events: [{ id }], prevCursor: null }),
    pendingAsksFor: () => [],
    listRuns: () => [],
  };
  const chat = new ReviewChat(
    store,
    orchestrator,
    {
      hasClone: () => true,
      addPullRequestWorktree: async () => '/tmp/review-chat',
      removeWorktree: async () => undefined,
    },
    () => true,
    () => undefined,
  );
  return { chat, settings };
}

test('review discussions are isolated per Companion profile', async () => {
  const { chat } = fixture();

  const alice = await chat.ask('review-1', null, 'Explain this finding.', 'alice');
  const bob = await chat.ask('review-1', null, 'Show me the evidence.', 'bob');

  assert.notEqual(alice.runId, bob.runId);
  assert.equal(chat.runFor('review-1', 'alice').id, alice.runId);
  assert.equal(chat.runFor('review-1', 'bob').id, bob.runId);
});

test('a corrupted cross-profile mapping does not expose another reviewer transcript', async () => {
  const { chat, settings } = fixture();
  const alice = await chat.ask('review-1', null, 'Explain this finding.', 'alice');
  settings.set('review:chat:review-1:bob', alice.runId);

  assert.equal(chat.runFor('review-1', 'bob'), null);
  assert.deepEqual(await chat.history('review-1', 'bob', null, 100), { events: [], prevCursor: null });
});
