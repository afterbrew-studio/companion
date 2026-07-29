import assert from 'node:assert/strict';
import test from 'node:test';
import { REPO_PRESETS, findPreset, resolveSteps } from '../dist/contract/presets.js';

const all = () => true;
const none = () => false;

test('every preset is reachable by its own id', () => {
  for (const preset of REPO_PRESETS) assert.equal(findPreset(preset.id)?.id, preset.id);
  assert.equal(findPreset('nope'), undefined);
});

test('the OSS preset does not post to GitHub on its own', () => {
  // The whole point for a public repo: an AI review appearing under the
  // maintainer's name on a stranger's first PR is a reputational act, so the
  // verdict lands in Companion and a human decides.
  const oss = findPreset('oss');
  const review = oss.pipeline.steps.find((s) => s.kind === 'ai-review');
  assert.equal(review.post, false);
  assert.equal(oss.automation.autoMerge, false);
});

test('the internal preset does gate and merge, which is the difference', () => {
  const internal = findPreset('internal');
  assert.equal(internal.automation.autoMerge, true);
  assert.equal(internal.automation.prGate, true);
  assert.ok(internal.pipeline.steps.some((s) => s.kind === 'checks-gate'));
});

test('watch-only turns everything off and creates nothing', () => {
  const watch = findPreset('watch');
  assert.equal(watch.pipeline, null);
  assert.deepEqual(Object.values(watch.automation), [false, false, false, false, false]);
});

test('a preset expands to inline step specs the engine accepts', () => {
  const { steps, skipped } = resolveSteps(findPreset('oss'), all);
  assert.deepEqual(skipped, []);
  assert.equal(steps.length, 2);
  for (const spec of steps) {
    assert.equal(spec.type, 'inline');
    assert.ok(spec.step.name, 'a step with no name renders as a blank row');
    assert.ok(spec.step.onFailure === 'halt' || spec.step.onFailure === 'continue');
  }
});

test('the slop screen runs first, so a throwaway PR does not spend a review', () => {
  const { steps } = resolveSteps(findPreset('oss'), all);
  assert.equal(steps[0].step.kind, 'slop-check');
  assert.equal(steps[0].step.onFailure, 'halt');
});

test('a step whose module is disabled is dropped and reported, never left to error', () => {
  const { steps, skipped } = resolveSteps(findPreset('oss'), none);
  assert.deepEqual(skipped, ['slop-check']);
  assert.deepEqual(
    steps.map((s) => s.step.kind),
    ['ai-review'],
  );
});

test('only the module the step needs is consulted, not every module', () => {
  const asked = [];
  resolveSteps(findPreset('oss'), (id) => {
    asked.push(id);
    return true;
  });
  assert.deepEqual(asked, ['slop'], 'ai-review belongs to code itself and needs no check');
});

test('a preset with no pipeline resolves to no steps rather than throwing', () => {
  assert.deepEqual(resolveSteps(findPreset('watch'), all), { steps: [], skipped: [] });
});

test('the configured threshold reaches the step config', () => {
  const { steps } = resolveSteps(findPreset('oss'), all);
  assert.equal(steps[0].step.config.threshold, 70);
});
