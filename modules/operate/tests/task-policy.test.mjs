import assert from 'node:assert/strict';
import test from 'node:test';
import {
  convertPolicyMode,
  moduleTaskPolicyReach,
  OPEN_TASK_POLICY,
  taskPolicyAllows,
  withModuleAllowed,
  withTaskAllowed,
} from '../dist/contract/index.js';

/**
 * The policy algebra behind the machine settings page. Two things must hold
 * whatever the editor does to it: what a machine may run TODAY never changes by
 * accident, and whether an entry covers work a module registers LATER is
 * decided by blanket-vs-enumerated, not by the mode.
 */

const group = (moduleId, ...names) => ({
  moduleId,
  moduleTitle: moduleId,
  tasks: names.map((name) => ({ id: `${moduleId}.${name}`, label: name, placeable: true })),
});

const GROUPS = [group('code', 'fix', 'review', 'triage'), group('board', 'worker', 'plan')];
const TASK_IDS = GROUPS.flatMap((g) => g.tasks.map((t) => t.id));

/** What the machine may run today, as one comparable vector. */
const effective = (policy) => TASK_IDS.map((id) => taskPolicyAllows(policy, id));

test('switching mode preserves what the machine may do today', () => {
  const before = { mode: 'deny', modules: ['board'], tasks: ['code.fix'] };
  const after = convertPolicyMode(before, GROUPS, 'allow');
  assert.equal(after.mode, 'allow');
  assert.deepEqual(effective(after), effective(before));
});

test('deny to allow and back preserves every answer', () => {
  const before = { mode: 'deny', modules: ['board'], tasks: ['code.fix'] };
  const back = convertPolicyMode(convertPolicyMode(before, GROUPS, 'allow'), GROUPS, 'deny');
  assert.deepEqual(effective(back), effective(before));
});

test('a fully allowed module converts to a blanket, so tasks added later stay covered', () => {
  const openToEverything = { mode: 'deny', modules: [], tasks: [] };
  const after = convertPolicyMode(openToEverything, GROUPS, 'allow');
  assert.deepEqual([...after.modules].sort(), ['board', 'code']);
  assert.deepEqual(after.tasks, []);
  assert.equal(taskPolicyAllows(after, 'code.somethingnew'), true);
});

test('a partly allowed module converts to its tasks, so tasks added later are not covered', () => {
  const before = { mode: 'deny', modules: [], tasks: ['code.fix'] };
  const after = convertPolicyMode(before, GROUPS, 'allow');
  assert.ok(!after.modules.includes('code'));
  assert.deepEqual(
    after.tasks.filter((id) => id.startsWith('code.')).sort(),
    ['code.review', 'code.triage'],
  );
  assert.deepEqual(effective(after), effective(before));
  assert.equal(taskPolicyAllows(after, 'code.somethingnew'), false);
});

test('converting to the mode it already has returns the policy untouched', () => {
  const policy = { mode: 'allow', modules: ['code'], tasks: ['board.worker'] };
  assert.equal(convertPolicyMode(policy, GROUPS, 'allow'), policy);
});

test('entries whose module is not in this build are dropped, keeping their answer', () => {
  const before = { mode: 'allow', modules: [], tasks: ['ghost.task', 'code.fix'] };
  assert.equal(taskPolicyAllows(before, 'ghost.task'), true);
  const after = convertPolicyMode(before, GROUPS, 'deny');
  assert.deepEqual(after.tasks.filter((id) => id.startsWith('ghost')), []);
  assert.equal(taskPolicyAllows(after, 'ghost.task'), true);
});

test('picking one task under a module blanket expands it over today’s tasks and drops it', () => {
  const policy = { mode: 'allow', modules: ['code'], tasks: [] };
  assert.equal(taskPolicyAllows(policy, 'code.somethingnew'), true);
  const after = withTaskAllowed(policy, GROUPS, 'code.fix', false);
  assert.ok(!after.modules.includes('code'));
  assert.deepEqual([...after.tasks].sort(), ['code.review', 'code.triage']);
  assert.equal(taskPolicyAllows(after, 'code.fix'), false);
  assert.equal(taskPolicyAllows(after, 'code.review'), true);
  assert.equal(taskPolicyAllows(after, 'code.somethingnew'), false);
});

test('ticking a whole module clears the individual entries under it', () => {
  const policy = { mode: 'allow', modules: [], tasks: ['code.fix', 'board.worker'] };
  const after = withModuleAllowed(policy, 'code', true);
  assert.deepEqual(after.modules, ['code']);
  assert.deepEqual(after.tasks, ['board.worker']);
  assert.equal(taskPolicyAllows(after, 'code.somethingnew'), true);
});

test('under deny, ticking a module removes its blanket refusal', () => {
  const policy = { mode: 'deny', modules: ['code'], tasks: [] };
  assert.equal(taskPolicyAllows(policy, 'code.fix'), false);
  const after = withModuleAllowed(policy, 'code', true);
  assert.deepEqual(after.modules, []);
  assert.equal(taskPolicyAllows(after, 'code.fix'), true);
});

/**
 * Reach is what a row displays, and it must never agree between two policies
 * that answer a future task differently. The pair that matters most is the
 * `deny` default (uniform by ABSENCE of any entry) against an `allow` policy
 * listing the very same tasks: identical ticks today, opposite answers later.
 */
test('reach tells the deny default apart from the same tasks listed under allow', () => {
  const denyDefault = OPEN_TASK_POLICY;
  const allowEachTask = { mode: 'allow', modules: [], tasks: ['code.fix', 'code.review', 'code.triage'] };
  // Identical today.
  assert.deepEqual(effective(denyDefault).slice(0, 3), effective(allowEachTask).slice(0, 3));
  // Opposite later, so reach must differ.
  assert.equal(taskPolicyAllows(denyDefault, 'code.somethingnew'), true);
  assert.equal(taskPolicyAllows(allowEachTask, 'code.somethingnew'), false);
  assert.equal(moduleTaskPolicyReach(denyDefault, 'code'), 'all');
  assert.equal(moduleTaskPolicyReach(allowEachTask, 'code'), 'partial');
});

test('reach agrees with the answer a module gives a task it has not registered yet', () => {
  const cases = [
    [{ mode: 'deny', modules: [], tasks: [] }, 'all'],
    [{ mode: 'deny', modules: ['code'], tasks: [] }, 'none'],
    [{ mode: 'deny', modules: [], tasks: ['code.fix'] }, 'partial'],
    [{ mode: 'allow', modules: ['code'], tasks: [] }, 'all'],
    [{ mode: 'allow', modules: [], tasks: [] }, 'none'],
    [{ mode: 'allow', modules: [], tasks: ['code.fix'] }, 'partial'],
  ];
  for (const [policy, expected] of cases) {
    assert.equal(moduleTaskPolicyReach(policy, 'code'), expected, JSON.stringify(policy));
    // A uniform reach must match what the policy actually answers for new work.
    if (expected !== 'partial') {
      assert.equal(taskPolicyAllows(policy, 'code.somethingnew'), expected === 'all', JSON.stringify(policy));
    }
  }
});

test('reach of one module ignores entries belonging to another', () => {
  const policy = { mode: 'deny', modules: [], tasks: ['board.worker'] };
  assert.equal(moduleTaskPolicyReach(policy, 'code'), 'all');
  assert.equal(moduleTaskPolicyReach(policy, 'board'), 'partial');
});

test('under deny, unticking a module adds a blanket refusal that covers later tasks', () => {
  const policy = { mode: 'deny', modules: [], tasks: [] };
  const after = withModuleAllowed(policy, 'code', false);
  assert.deepEqual(after.modules, ['code']);
  assert.equal(taskPolicyAllows(after, 'code.somethingnew'), false);
  assert.equal(taskPolicyAllows(after, 'board.worker'), true);
});
