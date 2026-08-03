import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import migrations from '../dist/api/migrations.js';
import { PrReviewsStore } from '../dist/api/pr-reviews-store.js';

function fixture() {
  const db = new Database(':memory:');
  for (const migration of migrations) migration.up(db);
  return new PrReviewsStore(db);
}

function runningReview() {
  return {
    id: 'prr-race',
    repo: 'acme/app',
    prNumber: 7,
    runId: null,
    runIds: [],
    source: 'agent',
    status: 'running',
    verdict: null,
    error: null,
    progress: {
      phase: 'reviewing',
      completed: 0,
      total: 2,
      message: 'Reviewing changed files',
      updatedAt: 100,
      budget: { modelCalls: 1, maxModelCalls: 20, startedAt: 50, deadlineAt: 3_600_050 },
    },
    coverage: {
      state: 'unavailable',
      reviewedGroups: 1,
      totalGroups: 2,
      reviewedFiles: 2,
      totalFiles: 4,
      unread: [],
    },
    createdAt: 50,
    headSha: 'abc123',
    depth: 'in-depth',
    strictness: 'balanced',
    findings: [],
  };
}

test('cancellation wins atomically over late child starts and aggregate completion', () => {
  const store = fixture();
  const review = runningReview();
  store.insert(review);

  assert.equal(store.appendRun(review.id, 'run-1'), true);
  assert.equal(store.running(review.repo, review.prNumber)?.id, review.id);
  assert.equal(
    store.terminateRunning(review.id, 'cancelled', 'cancelled by a maintainer', {
      ...review.progress,
      phase: 'complete',
      message: 'Review cancelled',
      updatedAt: 200,
    }, review.coverage),
    true,
  );

  assert.equal(store.appendRun(review.id, 'run-too-late'), false);
  assert.equal(store.finish({ ...review, status: 'pending' }), false);

  const stored = store.get(review.id);
  assert.equal(stored.status, 'cancelled');
  assert.equal(stored.error, 'cancelled by a maintainer');
  assert.equal(stored.coverage.state, 'partial');
  assert.deepEqual(stored.runIds, ['run-1']);
  assert.equal(store.running(review.repo, review.prNumber), undefined);
});

test('only the first terminal transition can settle a running review', () => {
  const store = fixture();
  const review = runningReview();
  store.insert(review);

  assert.equal(
    store.terminateRunning(review.id, 'failed', 'aggregate review time budget exhausted', {
      ...review.progress,
      phase: 'complete',
      message: 'Review stopped at its one-hour safety limit',
      updatedAt: 300,
    }, review.coverage),
    true,
  );
  assert.equal(
    store.terminateRunning(review.id, 'cancelled', 'cancelled by a maintainer', review.progress, review.coverage),
    false,
  );
  assert.equal(store.get(review.id).status, 'failed');
});

test('boot recovery preserves budget evidence and marks read coverage partial', () => {
  const store = fixture();
  const review = runningReview();
  store.insert(review);

  assert.deepEqual(store.failInterrupted(), [review.repo]);
  const recovered = store.get(review.id);
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.progress.phase, 'complete');
  assert.equal(recovered.progress.budget.modelCalls, 1);
  assert.equal(recovered.coverage.state, 'partial');
});

test('late sibling usage updates terminal budget without reviving its progress phase', () => {
  const store = fixture();
  const review = runningReview();
  store.insert(review);
  store.terminateRunning(
    review.id,
    'failed',
    'aggregate review token budget exhausted',
    { ...review.progress, phase: 'complete', message: 'Review stopped at its aggregate token limit', updatedAt: 250 },
    review.coverage,
  );

  store.setBudgetEvidence(review.id, {
    ...review.progress.budget,
    tokenUsage: {
      inputTokens: 900,
      outputTokens: 100,
      maxTokens: 1_000,
      reportedRuns: 2,
      missingRuns: 0,
      estimatedCostUsd: 0.01,
      costPartial: false,
    },
  });

  const stored = store.get(review.id);
  assert.equal(stored.status, 'failed');
  assert.equal(stored.progress.phase, 'complete');
  assert.equal(stored.progress.message, 'Review stopped at its aggregate token limit');
  assert.equal(stored.progress.budget.tokenUsage.reportedRuns, 2);
});

test('latest review decoration batches a repository beyond SQLite parameter ceilings', () => {
  const store = fixture();
  const base = runningReview();
  const numbers = Array.from({ length: 1_205 }, (_, index) => index + 1);
  for (const number of numbers) {
    store.insert({
      ...base,
      id: `prr-${number}`,
      prNumber: number,
      status: 'pending',
      createdAt: number,
    });
  }

  const latest = store.latestByNumber('acme/app', numbers);
  assert.equal(latest.size, numbers.length);
  assert.equal(latest.get(1).status, 'pending');
  assert.equal(latest.get(1_205).status, 'pending');
});
