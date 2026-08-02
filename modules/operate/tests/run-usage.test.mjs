import assert from 'node:assert/strict';
import test from 'node:test';
import { usageSnapshot } from '../dist/api/operate-service.js';

function run(usage, inputTokens, outputTokens, model = 'claude-sonnet-4-6') {
  return {
    model,
    inputTokens,
    outputTokens,
    harness: { capabilities: { usage } },
  };
}

test('run usage uses Operate pricing and keeps unpriced tokens explicit', () => {
  assert.deepEqual(usageSnapshot(run('tokens', 1_000_000, 1_000_000)), {
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    estimatedCostUsd: 18,
    telemetry: 'reported',
  });
  assert.deepEqual(usageSnapshot(run('tokens', 500, 100, 'private-model')), {
    inputTokens: 500,
    outputTokens: 100,
    estimatedCostUsd: null,
    telemetry: 'reported',
  });
});

test('zero-token rows distinguish missing telemetry from an unsupported harness', () => {
  assert.equal(usageSnapshot(run('tokens', 0, 0)).telemetry, 'missing');
  assert.equal(usageSnapshot(run('none', 0, 0)).telemetry, 'unsupported');
  assert.equal(usageSnapshot(run('cost', 0, 0)).telemetry, 'unsupported');
});
