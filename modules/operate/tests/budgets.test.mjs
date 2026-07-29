import assert from 'node:assert/strict';
import test from 'node:test';
import { Budgets, BudgetExceededError, monthStart } from '../dist/api/budgets.js';

/**
 * A stand-in runs store. `rows` are (model, input, output) tuples the aggregate
 * would have returned for the requested window; the fake asserts the window is
 * the current month so a regression in `monthStart` cannot pass silently.
 */
function storeOf(instanceRows, userRows = {}) {
  return {
    spendByModel(since, userId) {
      assert.equal(since, monthStart(), 'the gate must measure the current calendar month');
      if (userId === undefined) return instanceRows;
      return userRows[userId] ?? [];
    },
    spendByDimension() {
      return [];
    },
  };
}

function configOf(values) {
  return { values: () => values, get: (k) => values[k] ?? null };
}

/** 1M output tokens of opus-4-8 ($25/MTok) = $25. */
const OPUS_25 = [{ model: 'claude-opus-4-8', runs: 1, input: 0, output: 1_000_000 }];

function budgets(rows, config, alerts = []) {
  return new Budgets(rows, configOf(config), (title, body) => alerts.push({ title, body }));
}

test('no configured ceiling lets every run through', () => {
  const b = budgets(storeOf(OPUS_25), {});
  assert.doesNotThrow(() => b.check('alice'));
});

test('a run is refused once the instance ceiling is reached', () => {
  const b = budgets(storeOf(OPUS_25), { monthlyBudgetUsd: 20 });
  assert.throws(() => b.check('alice'), BudgetExceededError);
});

test('the refusal names both numbers, because the person who hit it has to act on it', () => {
  const b = budgets(storeOf(OPUS_25), { monthlyBudgetUsd: 20 });
  try {
    b.check('alice');
    assert.fail('expected a refusal');
  } catch (err) {
    assert.match(err.message, /\$25\.00/);
    assert.match(err.message, /\$20\.00/);
    assert.equal(err.status, 402);
  }
});

test('spend below the ceiling passes', () => {
  const b = budgets(storeOf(OPUS_25), { monthlyBudgetUsd: 100 });
  assert.doesNotThrow(() => b.check('alice'));
});

test('a per-user ceiling refuses that profile while the instance still has room', () => {
  const store = storeOf(OPUS_25, { alice: OPUS_25, bob: [] });
  const b = budgets(store, { monthlyBudgetUsd: 1000, userMonthlyBudgetUsd: 10 });
  assert.throws(() => b.check('alice'), BudgetExceededError);
  assert.doesNotThrow(() => b.check('bob'));
});

test('an automation run with no profile is not held to a per-user ceiling', () => {
  // Attributing shared automation to nobody's personal budget is deliberate:
  // the instance ceiling is what governs it.
  const b = budgets(storeOf([], {}), { userMonthlyBudgetUsd: 1 });
  assert.doesNotThrow(() => b.check(null));
});

test('an unpriced model does not silently count as zero spend, it is reported', () => {
  const rows = [{ model: 'some-local-llm', runs: 1, input: 500_000, output: 500_000 }];
  const b = budgets(storeOf(rows), { monthlyBudgetUsd: 10 });
  const status = b.status('alice');
  assert.equal(status.instance.spentUsd, 0);
  assert.equal(status.unpricedTokens, 1_000_000);
  // And it does not block, because guessing a price would be worse than not having one.
  assert.doesNotThrow(() => b.check('alice'));
});

test('crossing the alert threshold notifies once, not on every run', () => {
  const alerts = [];
  const b = budgets(storeOf(OPUS_25), { monthlyBudgetUsd: 30, budgetAlertPercent: 80 }, alerts);
  b.check('alice');
  b.check('alice');
  b.check('alice');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].title, /83%|84%/);
});

test('spend under the alert threshold notifies nobody', () => {
  const alerts = [];
  const b = budgets(storeOf(OPUS_25), { monthlyBudgetUsd: 1000, budgetAlertPercent: 80 }, alerts);
  b.check('alice');
  assert.equal(alerts.length, 0);
});

test('an alert sink that throws does not take the run down with it', () => {
  const b = new Budgets(storeOf(OPUS_25), configOf({ monthlyBudgetUsd: 30 }), () => {
    throw new Error('inbox unavailable');
  });
  assert.doesNotThrow(() => b.check('alice'));
});

test('status reports no percentage when no ceiling is configured', () => {
  const status = budgets(storeOf(OPUS_25), {}).status('alice');
  assert.equal(status.instance.percent, null);
  assert.equal(status.instance.exceeded, false);
  assert.equal(status.instance.spentUsd, 25);
});

test('a nonsensical configured ceiling is treated as unset rather than as zero', () => {
  // A 0 ceiling stored as "off" must not read as "you may spend nothing".
  for (const bad of [0, -5, 'lots', null]) {
    const b = budgets(storeOf(OPUS_25), { monthlyBudgetUsd: bad });
    assert.doesNotThrow(() => b.check('alice'), `ceiling ${String(bad)} should disable the gate`);
  }
});

test('attribution buckets price per model, not per bucket average', () => {
  const store = {
    spendByModel: () => [],
    spendByDimension: () => [
      // One bucket, two models with very different prices.
      { key: 'alice', model: 'claude-opus-4-8', runs: 1, input: 0, output: 1_000_000 }, // $25
      { key: 'alice', model: 'claude-haiku-4-5', runs: 1, input: 0, output: 1_000_000 }, // $5
    ],
  };
  const [row] = budgets(store, {}).breakdown().byUser;
  assert.equal(row.costUsd, 30);
  assert.equal(row.runs, 2);
  assert.equal(row.partial, false);
});

test('a bucket containing an unpriced model is marked as a floor', () => {
  const store = {
    spendByModel: () => [],
    spendByDimension: () => [
      { key: 'alice', model: 'claude-haiku-4-5', runs: 1, input: 0, output: 1_000_000 },
      { key: 'alice', model: 'mystery-model', runs: 1, input: 0, output: 9_000_000 },
    ],
  };
  const [row] = budgets(store, {}).breakdown().byUser;
  assert.equal(row.partial, true);
  assert.equal(row.costUsd, 5);
});

test('null attribution keys are labelled, never rendered as an empty row', () => {
  const store = {
    spendByModel: () => [],
    spendByDimension: (dimension) => [
      { key: null, model: 'claude-haiku-4-5', runs: 1, input: 0, output: 1_000 },
    ],
  };
  const b = budgets(store, {});
  assert.equal(b.breakdown().byUser[0].label, 'automation');
  assert.equal(b.breakdown().byTask[0].label, 'unattributed');
  assert.equal(b.breakdown().byRepo[0].label, 'no repository');
});
