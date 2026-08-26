import assert from 'node:assert/strict';
import test from 'node:test';
import {
  REFUSED_STEP_KINDS,
  StepRefusedError,
  assertPipelineRunnable,
  assertStepRunnable,
  isRefusedStepKind,
} from '../dist/api/merge-refusal.js';
import { savePipelineSchema } from '../dist/api/pipelines.js';

/**
 * The refusal these cover is an instance-level policy, not a permission. That
 * distinction is the reason for most of the assertions below: a permission can be
 * granted, so a check that behaves like one invites someone to look for the grant.
 *
 * The authoritative check runs at step dispatch. The save-time check exists so the
 * failure lands in the editor rather than mid-run, and is deliberately tested as a
 * separate thing so that removing one does not silently look covered by the other.
 */

test('merge is refused', () => {
  assert.ok(isRefusedStepKind('merge'));
  assert.ok(REFUSED_STEP_KINDS.includes('merge'));
});

test('ordinary step kinds are not refused', () => {
  // A refusal list that rejects everything would pass a test asserting only that
  // merge is rejected, so the negative side is asserted explicitly.
  for (const kind of ['pr-action', 'label', 'comment', 'agent', 'ai-review', 'checks-gate']) {
    assert.equal(isRefusedStepKind(kind), false, `${kind} must remain runnable`);
  }
});

test('a non-string kind is not refused by accident', () => {
  for (const kind of [undefined, null, 42, {}, ['merge']]) {
    assert.equal(isRefusedStepKind(kind), false);
  }
});

test('executing a merge step throws, and identifies itself as a refusal', () => {
  assert.throws(
    () => assertStepRunnable({ kind: 'merge' }),
    (err) => {
      assert.ok(err instanceof StepRefusedError);
      assert.equal(err.kind, 'merge');
      // Not an authorisation failure. If this ever reads as one, someone will go
      // looking for the role that grants it.
      assert.match(err.message, /instance-level policy, not a permission/);
      assert.match(err.message, /cannot be granted, imported, configured or overridden/);
      return true;
    },
  );
});

test('executing an ordinary step does not throw', () => {
  assert.doesNotThrow(() => assertStepRunnable({ kind: 'pr-action' }));
  assert.doesNotThrow(() => assertStepRunnable({ kind: 'label' }));
});

test('a pipeline containing a merge step is refused, wherever the step sits', () => {
  for (const steps of [
    [{ kind: 'merge' }],
    [{ kind: 'label' }, { kind: 'merge' }],
    [{ kind: 'merge' }, { kind: 'comment' }],
  ]) {
    assert.throws(() => assertPipelineRunnable(steps), StepRefusedError);
  }
});

test('a pipeline with no refused step passes, including an empty one', () => {
  assert.doesNotThrow(() => assertPipelineRunnable([{ kind: 'label' }, { kind: 'comment' }]));
  assert.doesNotThrow(() => assertPipelineRunnable([]));
  assert.doesNotThrow(() => assertPipelineRunnable(undefined));
});

test('every refused kind in one pipeline is named once, not one error per step', () => {
  assert.throws(
    () => assertPipelineRunnable([{ kind: 'merge' }, { kind: 'merge' }]),
    (err) => {
      // Three merge steps should not need three round trips to fix.
      assert.equal(err.message.match(/merge/g).length, 1);
      return true;
    },
  );
});

// A fully valid merge step. It has to be valid: `superRefine` only runs once the
// base schema parses, so an incomplete fixture would be rejected for its shape and
// the test would pass without ever reaching the refusal it exists to check.
const validMergeStep = {
  type: 'inline',
  step: {
    kind: 'merge',
    name: 'merge it',
    onFailure: 'halt',
    config: { method: 'squash', deleteBranch: true, requirePinnedHead: true },
  },
};

const validLabelStep = {
  type: 'inline',
  step: {
    kind: 'label',
    name: 'tag it',
    onFailure: 'halt',
    config: { labels: ['ready'] },
  },
};

test('savePipelineSchema rejects an otherwise-valid inline merge step', () => {
  const result = savePipelineSchema.safeParse({
    type: 'pr',
    name: 'ship it',
    steps: [validMergeStep],
  });
  assert.equal(result.success, false);
  const issues = JSON.stringify(result.error.issues);
  assert.match(issues, /refused by this instance/);
  // The refusal must be the reason, not a coincidental shape complaint.
  assert.match(issues, /instance-level policy, not a permission/);
});

test('savePipelineSchema still accepts a pipeline with no refused step', () => {
  const result = savePipelineSchema.safeParse({
    type: 'pr',
    name: 'just build',
    steps: [validLabelStep],
  });
  // If this fails the refusal is over-broad, which would be worse than missing:
  // an instance that refuses everything looks identical to one that works.
  assert.equal(result.success, true, JSON.stringify(result.error?.issues));
});
