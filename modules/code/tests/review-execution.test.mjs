import assert from 'node:assert/strict';
import test from 'node:test';
import { ReviewExecution } from '../dist/api/review-execution.js';

test('one aggregate deadline caps every child timeout', () => {
  let now = 1_000;
  const execution = new ReviewExecution({ now: () => now, wallMs: 120_000 });

  assert.equal(execution.claim(300_000), 120_000);
  now += 95_001;
  assert.throws(() => execution.claim(60_000), /time budget exhausted/);
  assert.equal(execution.stopped, true);
  assert.equal(execution.snapshot().deadlineAt, 121_000);
});

test('chunk and verifier turns can reserve the final summary call', () => {
  const execution = new ReviewExecution({ maxModelCalls: 3 });

  execution.claim(60_000, 1);
  execution.claim(60_000, 1);
  assert.equal(execution.remainingCalls(1), 0);
  assert.throws(() => execution.claim(60_000, 1), /agent-call budget exhausted/);

  // The reserved summary still fits, but nothing after it does.
  execution.claim(60_000);
  assert.equal(execution.snapshot().modelCalls, 3);
  assert.throws(() => execution.claim(60_000), /agent-call budget exhausted/);
});

test('a stopped review cannot enqueue more work and exposes cancellable children', () => {
  const execution = new ReviewExecution();
  execution.trackQueued('q-1');
  execution.trackQueued('q-2');
  execution.trackStarted('q-1', 'run-1');

  assert.deepEqual(execution.queuedIds(), ['q-2']);
  assert.deepEqual(execution.runningIds(), ['run-1']);

  execution.stop('cancelled by a maintainer');
  assert.throws(() => execution.claim(60_000), /cancelled by a maintainer/);

  execution.trackFinished(null, 'run-1');
  execution.trackFinished('q-2', null);
  assert.deepEqual(execution.queuedIds(), []);
  assert.deepEqual(execution.runningIds(), []);
});

test('claimed calls are monotonic so cancellation cannot create a retry loop', () => {
  const execution = new ReviewExecution({ maxModelCalls: 2 });
  execution.claim(60_000);
  execution.trackQueued('q-1');
  execution.trackFinished('q-1', null);

  assert.equal(execution.snapshot().modelCalls, 1);
  execution.claim(60_000);
  assert.equal(execution.remainingCalls(), 0);
});

test('child usage is aggregated once with one honest partial-cost flag', () => {
  const execution = new ReviewExecution({ maxTokens: 10_000 });

  assert.equal(
    execution.recordUsage('run-1', {
      inputTokens: 1_200,
      outputTokens: 300,
      estimatedCostUsd: 0.012,
      telemetry: 'reported',
    }),
    null,
  );
  // A promise callback may be observed twice during cancellation. It must not
  // double-charge the aggregate.
  execution.recordUsage('run-1', {
    inputTokens: 9_000,
    outputTokens: 9_000,
    estimatedCostUsd: 99,
    telemetry: 'reported',
  });
  execution.recordUsage('run-2', {
    inputTokens: 400,
    outputTokens: 100,
    estimatedCostUsd: null,
    telemetry: 'reported',
  });

  assert.deepEqual(execution.snapshot().tokenUsage, {
    inputTokens: 1_600,
    outputTokens: 400,
    maxTokens: 10_000,
    reportedRuns: 2,
    missingRuns: 0,
    estimatedCostUsd: 0.012,
    costPartial: true,
  });
});

test('the aggregate token ceiling stops new work and leaves active peers cancellable', () => {
  const execution = new ReviewExecution({ maxTokens: 1_000 });
  execution.trackStarted(null, 'run-1');
  execution.trackStarted(null, 'run-2');

  assert.match(
    execution.recordUsage('run-1', {
      inputTokens: 800,
      outputTokens: 200,
      estimatedCostUsd: 0.01,
      telemetry: 'reported',
    }),
    /token budget exhausted/,
  );
  assert.equal(execution.stopped, true);
  assert.deepEqual(execution.runningIds(), ['run-1', 'run-2']);
  assert.throws(() => execution.claim(60_000), /token budget exhausted/);
});

test('cumulative live usage is monotonic, visible before settlement and stops at the ceiling', () => {
  const execution = new ReviewExecution({ maxTokens: 1_000 });
  execution.trackStarted(null, 'run-live');

  assert.equal(execution.observeUsage('run-live', {
    inputTokens: 400,
    outputTokens: 100,
    estimatedCostUsd: 0.004,
    telemetry: 'reported',
  }), null);
  // Duplicate and out-of-order snapshots must not charge the aggregate twice.
  execution.observeUsage('run-live', {
    inputTokens: 350,
    outputTokens: 80,
    estimatedCostUsd: 0.003,
    telemetry: 'reported',
  });
  assert.deepEqual(execution.snapshot().tokenUsage, {
    inputTokens: 400,
    outputTokens: 100,
    maxTokens: 1_000,
    reportedRuns: 1,
    missingRuns: 0,
    estimatedCostUsd: 0.004,
    costPartial: false,
  });

  assert.match(execution.observeUsage('run-live', {
    inputTokens: 800,
    outputTokens: 200,
    estimatedCostUsd: 0.009,
    telemetry: 'reported',
  }), /token budget exhausted/);
  assert.equal(execution.stopped, true);
  // Final settlement uses the same cumulative row and cannot double-count it.
  assert.equal(execution.recordUsage('run-live', {
    inputTokens: 800,
    outputTokens: 200,
    estimatedCostUsd: 0.009,
    telemetry: 'reported',
  }), null);
  assert.equal(execution.snapshot().tokenUsage.inputTokens, 800);
  assert.equal(execution.snapshot().tokenUsage.outputTokens, 200);
});

test('missing or unsupported usage fails closed without double-counting a run', () => {
  const execution = new ReviewExecution();

  assert.match(
    execution.recordUsage('run-blind', {
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: null,
      telemetry: 'unsupported',
    }),
    /cannot report token usage/,
  );
  assert.equal(execution.recordUsage('run-blind', null), null);
  assert.deepEqual(execution.snapshot().tokenUsage, {
    inputTokens: 0,
    outputTokens: 0,
    maxTokens: 2_000_000,
    reportedRuns: 0,
    missingRuns: 1,
    estimatedCostUsd: 0,
    costPartial: true,
  });
});

test('invalid configured limits fall back instead of disabling the guard', () => {
  const execution = new ReviewExecution({ maxModelCalls: Number.NaN, maxTokens: Number.POSITIVE_INFINITY });
  assert.equal(execution.snapshot().maxModelCalls, 20);
  assert.equal(execution.snapshot().tokenUsage.maxTokens, 2_000_000);
});
