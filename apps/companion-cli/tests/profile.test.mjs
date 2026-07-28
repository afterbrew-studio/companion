import assert from 'node:assert/strict';
import test from 'node:test';
import { OPTIONAL_MODULES, modulesFor, profileFromEnv, withDependencies } from '../dist/profile.js';

test('slim starts with nothing optional, full starts with all of it', () => {
  assert.deepEqual(modulesFor('slim'), []);
  assert.deepEqual(modulesFor('full'), OPTIONAL_MODULES.map((m) => m.id));
});

test('COMPANION_PROFILE answers without a prompt, and ignores nonsense', () => {
  const prev = process.env.COMPANION_PROFILE;
  try {
    process.env.COMPANION_PROFILE = 'full';
    assert.equal(profileFromEnv(), 'full');
    process.env.COMPANION_PROFILE = 'FULL';
    assert.equal(profileFromEnv(), 'full', 'case should not matter');
    process.env.COMPANION_PROFILE = 'enormous';
    assert.equal(profileFromEnv(), null, 'an unknown value must fall through to the prompt, not to full');
    delete process.env.COMPANION_PROFILE;
    assert.equal(profileFromEnv(), null);
  } finally {
    if (prev === undefined) delete process.env.COMPANION_PROFILE;
    else process.env.COMPANION_PROFILE = prev;
  }
});

test('a custom pick pulls in what it depends on', () => {
  // Ideas alone would fail at install with "enable dependency first", and the
  // answer is always the same, so it is added rather than reported.
  assert.deepEqual(withDependencies(['planner']), ['plan', 'board', 'refinement', 'planner']);
  assert.deepEqual(withDependencies(['automations']), ['plan', 'automations']);
});

test('the closure is in install order, not selection order', () => {
  // dependsOn is only satisfied once the dependency is enabled, so the sequence
  // the CLI installs in has to be topological.
  const order = withDependencies(['planner', 'plan']);
  assert.ok(order.indexOf('plan') < order.indexOf('refinement'));
  assert.ok(order.indexOf('refinement') < order.indexOf('planner'));
});

test('modules with no optional dependencies are left exactly as picked', () => {
  assert.deepEqual(withDependencies(['slop', 'playground']), ['slop', 'playground']);
  assert.deepEqual(withDependencies([]), []);
});
