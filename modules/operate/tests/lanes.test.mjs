import assert from 'node:assert/strict';
import test from 'node:test';
import { isAutoLane, resolveHarness, resolveModel, resolveRunner } from '../dist/api/lanes.js';

/**
 * This cascade decides the machine, the runtime and the model of every run, and
 * gets those wrong quietly: the run still starts, it just behaves like
 * something else. Each precedence step gets a case, and so does every reason a
 * preference is allowed to lose.
 */

// ---------- machine ----------

test('an explicitly named machine wins over everything', () => {
  assert.equal(
    resolveRunner({ explicit: 'runner-b', hasPreparedCwd: true, laneRunnerId: 'runner-c', placed: 'runner-d' }),
    'runner-b',
  );
  // Explicitly null is a choice too: "the local machine", not "unset".
  assert.equal(
    resolveRunner({ explicit: null, hasPreparedCwd: false, laneRunnerId: 'runner-c', placed: 'runner-d' }),
    null,
  );
});

test('a prepared checkout beats the lane, because the code is only on that machine', () => {
  assert.equal(resolveRunner({ hasPreparedCwd: true, laneRunnerId: 'runner-c', placed: 'runner-d' }), null);
});

test('the lane beats placement when nothing is prepared', () => {
  assert.equal(resolveRunner({ hasPreparedCwd: false, laneRunnerId: 'runner-c', placed: 'runner-d' }), 'runner-c');
});

test('placement decides when no lane names a machine', () => {
  assert.equal(resolveRunner({ hasPreparedCwd: false, laneRunnerId: null, placed: 'runner-d' }), 'runner-d');
});

// ---------- runtime ----------

const OFFERED = ['moxxy', 'claude-code'];

test("the lane's runtime is used when the machine offers it", () => {
  assert.equal(
    resolveHarness({ laneHarness: 'claude-code', offered: OFFERED, machineDefault: 'moxxy' }),
    'claude-code',
  );
});

test('an explicit runtime outranks the lane', () => {
  assert.equal(
    resolveHarness({ explicit: 'moxxy', laneHarness: 'claude-code', offered: OFFERED, machineDefault: 'moxxy' }),
    'moxxy',
  );
});

test('a runtime this machine does not run falls back rather than failing the run', () => {
  // The lane was chosen for another machine, or this one's set changed since.
  assert.equal(
    resolveHarness({ laneHarness: 'codex', offered: OFFERED, machineDefault: 'moxxy' }),
    'moxxy',
  );
});

test('no lane runtime means the machine decides', () => {
  assert.equal(resolveHarness({ laneHarness: null, offered: OFFERED, machineDefault: 'moxxy' }), 'moxxy');
});

// ---------- model ----------

const NOTHING = { preferred: null, lanePin: null, laneDefault: null, taskPin: null };

test('a choice someone just made beats every standing preference', () => {
  assert.equal(
    resolveModel({ explicit: 'opus', preferred: 'a', lanePin: 'b', laneDefault: 'c', taskPin: 'd' }),
    'opus',
  );
});

test("the lane's task pin beats its default, which beats the instance pin", () => {
  assert.equal(resolveModel({ ...NOTHING, lanePin: 'b', laneDefault: 'c', taskPin: 'd' }), 'b');
  assert.equal(resolveModel({ ...NOTHING, laneDefault: 'c', taskPin: 'd' }), 'c');
  assert.equal(resolveModel({ ...NOTHING, taskPin: 'd' }), 'd');
});

test("the unit of work's own preference still outranks the lane", () => {
  // A board card chose its model once and every run it spawns should keep it,
  // days later, whichever lane someone happens to be in.
  assert.equal(resolveModel({ ...NOTHING, preferred: 'a', lanePin: 'b', laneDefault: 'c' }), 'a');
});

test('the stage route sits below an explicit/card choice and above lane defaults', () => {
  assert.equal(resolveModel({ ...NOTHING, preferred: 'card', routed: 'economy', lanePin: 'lane' }), 'card');
  assert.equal(resolveModel({ ...NOTHING, routed: 'economy', lanePin: 'lane', taskPin: 'task' }), 'economy');
});

test('nothing decided is null, which dispatch answers with its own defaults', () => {
  assert.equal(resolveModel(NOTHING), null);
});

// ---------- the empty lane ----------

test('an untouched lane is recognised so the lookups can be skipped', () => {
  assert.equal(isAutoLane({ runnerId: null, harness: null }), true);
  assert.equal(isAutoLane({ runnerId: null, harness: 'claude-code' }), false);
  assert.equal(isAutoLane({ runnerId: 'runner-b', harness: null }), false);
});
