import assert from 'node:assert/strict';
import test from 'node:test';
import { createStepOutputScopeResolver } from '../dist/api/ws-scope.js';

test('raw pipeline stdout is visible only to the run owner', () => {
  const resolve = createStepOutputScopeResolver();
  const scope = resolve({
    t: 'pipelineStep.output',
    repo: 'private/repo',
    runId: 'plr-1',
    ownerId: 'alice',
    stepIndex: 0,
    sequence: 1,
    chunk: 'private source\n',
  });

  assert.equal(scope('alice'), true);
  assert.equal(scope('bob'), false);
  assert.equal(resolve({ t: 'pipelineRuns.changed', repo: 'private/repo' }), null);
});
