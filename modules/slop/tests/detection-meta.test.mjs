import assert from 'node:assert/strict';
import test from 'node:test';
// The client slice is never built to dist (Vite reads it from source), so this
// imports the real module and lets node strip the types.
import { SLOP_BANDS, rankSignals, slopBand, slopBandRange } from '../src/client/detection-meta.ts';

function band(id) {
  const found = SLOP_BANDS.find((b) => b.id === id);
  assert.ok(found, `no ${id} band`);
  return found;
}

function signal(strength, ruleId) {
  return { ruleId, ruleName: ruleId, observation: 'evidence', strength };
}

// ---------- bands ----------

test('the score bands at 70 and at 40, both edges belonging upward', () => {
  assert.equal(slopBand(100).id, 'high');
  assert.equal(slopBand(70).id, 'high');
  assert.equal(slopBand(69).id, 'elevated');
  assert.equal(slopBand(40).id, 'elevated');
  assert.equal(slopBand(39).id, 'low');
  assert.equal(slopBand(0).id, 'low');
});

test('each band owns its lowest score and none claims the score below it', () => {
  for (const b of SLOP_BANDS) {
    assert.equal(slopBand(b.min).id, b.id);
    if (b.min > 0) assert.notEqual(slopBand(b.min - 1).id, b.id);
  }
});

test('a score outside 0 to 100 still lands in a band', () => {
  // The range is validated at parse time, but nothing downstream should rely on
  // it: a bandless score paints an uncoloured meter and captions no band.
  assert.equal(slopBand(-1).id, 'low');
  assert.equal(slopBand(1000).id, 'high');
});

test('band captions are read off the thresholds, so the legend states the real scale', () => {
  assert.equal(slopBandRange(band('high')), '70 and up');
  assert.equal(slopBandRange(band('elevated')), '40 to 69');
  assert.equal(slopBandRange(band('low')), 'under 40');
});

// ---------- signal ranking ----------

test('signals rank strongest first', () => {
  const ranked = rankSignals([signal('weak', 'a'), signal('strong', 'b'), signal('moderate', 'c')]);
  assert.deepEqual(
    ranked.map((s) => s.ruleId),
    ['b', 'c', 'a'],
  );
});

test('signals of equal strength keep the order the agent reported them in', () => {
  // Once strengths tie, the agent's order is the only ranking left; reshuffling
  // it would reorder the list on every render for no reason.
  const ranked = rankSignals([signal('strong', 'a'), signal('weak', 'b'), signal('strong', 'c'), signal('strong', 'd')]);
  assert.deepEqual(
    ranked.map((s) => s.ruleId),
    ['a', 'c', 'd', 'b'],
  );
});

test('ranking does not reorder the verdict it was handed', () => {
  const signals = [signal('weak', 'a'), signal('strong', 'b')];
  rankSignals(signals);
  assert.deepEqual(
    signals.map((s) => s.ruleId),
    ['a', 'b'],
  );
});
