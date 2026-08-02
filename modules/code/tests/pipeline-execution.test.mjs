import assert from 'node:assert/strict';
import test from 'node:test';
import { appendPipelineStepLog, PipelineExecution } from '../dist/api/pipeline-execution.js';

test('pipeline output is sequenced and keeps a bounded tail', () => {
  const first = appendPipelineStepLog(null, 'abcdef', 10, 8);
  const second = appendPipelineStepLog(first, 'ghijkl', 20, 8);

  assert.deepEqual(first, {
    text: 'abcdef',
    sequence: 1,
    truncated: false,
    updatedAt: 10,
  });
  assert.deepEqual(second, {
    text: 'efghijkl',
    sequence: 2,
    truncated: true,
    updatedAt: 20,
  });
});

test('a pipeline execution cancels registered children exactly once', async () => {
  const execution = new PipelineExecution();
  const calls = [];
  execution.onCancel(() => calls.push('queued'));
  execution.onCancel(async () => calls.push('running'));

  await Promise.all([execution.stop('maintainer stopped it'), execution.stop('duplicate')]);

  assert.equal(execution.stopped, true);
  assert.equal(execution.signal.aborted, true);
  assert.deepEqual(calls.sort(), ['queued', 'running']);

  execution.onCancel(() => calls.push('late'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((call) => call === 'late').length, 1);
});

test('cancellation can persist the newest not-yet-flushed step snapshot', () => {
  const execution = new PipelineExecution();
  let steps = [{ name: 'Build', status: 'running' }];
  execution.bindSnapshot(() => steps);
  steps = [{ name: 'Build', status: 'running', log: { sequence: 4, text: 'latest' } }];

  assert.equal(execution.snapshot()[0].log.text, 'latest');
});
