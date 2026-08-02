import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import { buildRolloutGate } from '../dist/api/production-evaluation-routes.js';
import { PlaygroundEvaluationStore } from '../dist/api/evaluation-store.js';
import migrations from '../dist/api/migrations.js';
import { PRODUCTION_EVALUATION_CASES, publicProductionCase } from '../dist/api/production-corpus.js';
import { ProductionEvaluations } from '../dist/api/production-evaluations.js';
import { ProductionSuiteBudgetGuard } from '../dist/api/production-suite-budget.js';

const adapterMeta = new Map([
  ['code.pr-review', { moduleId: 'code', label: 'PR review', task: 'code.pr-review', version: 3 }],
  ['code.issue-triage', { moduleId: 'code', label: 'Issue triage', task: 'code.triage', version: 2 }],
  ['slop.contribution-quality', { moduleId: 'slop', label: 'Quality', task: 'slop.detect', version: 4 }],
  ['planner.clarification', { moduleId: 'planner', label: 'Planner', task: 'planner.analyses', version: 5 }],
  ['refinement.decomposition', { moduleId: 'refinement', label: 'Refinement', task: 'refinement.analyses', version: 6 }],
]);

const cases = PRODUCTION_EVALUATION_CASES.map((definition) => {
  const meta = adapterMeta.get(definition.adapterId);
  return publicProductionCase(definition, { id: definition.adapterId, ...meta }, `prompt-${definition.id}`);
});
const fingerprints = new Map([...adapterMeta].map(([id]) => [id, `cfg-${id}`]));

function passingRun(record, overrides = {}) {
  return {
    id: `run-${record.id}`,
    caseId: record.id,
    caseName: record.name,
    caseRevision: record.revision,
    adapterId: record.adapterId,
    adapterVersion: record.adapterVersion,
    promptFingerprint: record.promptFingerprint,
    runId: 'agent-1',
    status: 'passed',
    checks: [],
    parsedOutput: {},
    message: '{}',
    error: null,
    durationMs: 1,
    inputTokens: 1,
    outputTokens: 1,
    model: 'model-a',
    configuration: {
      fingerprint: fingerprints.get(record.adapterId),
      task: record.task,
      taskModelPin: 'model-a',
      laneRunnerId: null,
      laneHarness: null,
      laneTaskModel: null,
      laneDefaultModel: null,
      daemonDefaultModel: 'model-a',
      actualModel: 'model-a',
      actualRunnerId: null,
      actualHarness: 'moxxy',
    },
    ownerId: 'alice',
    createdAt: 100,
    ...overrides,
  };
}

function passingProof(record) {
  return Array.from({ length: record.requiredPasses }, (_, index) => passingRun(record, {
    id: `run-${record.id}-${index}`,
    createdAt: 100 - index,
  }));
}

test('never-run safety cases block rollout instead of looking green', () => {
  const gate = buildRolloutGate(cases, [], fingerprints);
  assert.equal(gate.status, 'blocked');
  assert.equal(gate.total, cases.length);
  assert.equal(gate.notRun, cases.length);
  assert.equal(gate.blockers, cases.filter((record) => record.safetyCritical).length);
  assert.equal(gate.warnings, cases.filter((record) => !record.safetyCritical).length);
});

test('every current case must pass before the release gate is ready', () => {
  const gate = buildRolloutGate(cases, cases.flatMap((record) => passingProof(record)), fingerprints);
  assert.equal(gate.status, 'ready');
  assert.equal(gate.passed, cases.length);
  assert.equal(gate.blockers, 0);
  assert.equal(gate.warnings, 0);
});

test('a prompt/parser or model-setting change makes an old pass stale', () => {
  const runs = cases.flatMap((record) => passingProof(record));
  const first = runs.findIndex((run) => run.caseId === cases[0].id);
  const second = runs.findIndex((run) => run.caseId === cases[1].id);
  const third = runs.findIndex((run) => run.caseId === cases[2].id);
  runs[first] = passingRun(cases[0], { adapterVersion: cases[0].adapterVersion - 1 });
  runs[second] = passingRun(cases[1], {
    configuration: { ...passingRun(cases[1]).configuration, fingerprint: 'old-config' },
  });
  runs[third] = passingRun(cases[2], { promptFingerprint: 'old-prompt' });
  const gate = buildRolloutGate(cases, runs, fingerprints);
  assert.equal(gate.status, 'blocked');
  assert.equal(gate.stale, 3);
  assert.equal(gate.blockers, 3);
});

test('one stochastic pass is not enough for a safety-critical rollout decision', () => {
  const runs = cases.flatMap((record) =>
    record.safetyCritical ? [passingRun(record)] : passingProof(record),
  );
  const gate = buildRolloutGate(cases, runs, fingerprints);
  assert.equal(gate.status, 'blocked');
  assert.equal(gate.insufficient, cases.filter((record) => record.safetyCritical).length);
  assert.ok(gate.cases.filter((record) => record.safetyCritical).every((record) => record.currentPasses === 1));
});

test('the frozen corpus has stable unique ids and explicit pass/fail criteria', () => {
  assert.equal(new Set(PRODUCTION_EVALUATION_CASES.map((record) => record.id)).size, PRODUCTION_EVALUATION_CASES.length);
  for (const record of PRODUCTION_EVALUATION_CASES) {
    assert.match(record.id, /^production\./);
    assert.ok(adapterMeta.has(record.adapterId));
    assert.ok(record.expectation.requiredJsonPaths.length + Object.keys(record.expectation.expectedJson).length > 0);
    assert.ok(record.timeoutMs > 0);
  }
  for (const record of cases) assert.equal(record.requiredPasses, record.safetyCritical ? 2 : 1);
});

test('the maintainer gate covers false positives, test theatre and partial large-PR evidence', () => {
  const tags = new Set(PRODUCTION_EVALUATION_CASES.flatMap((record) => record.tags));
  assert.equal(tags.has('false-positive'), true);
  assert.equal(tags.has('test-theatre'), true);
  assert.equal(tags.has('partial-evidence'), true);

  const partial = PRODUCTION_EVALUATION_CASES.find((record) => record.id === 'production.slop-partial-diff-stays-undecided');
  assert.equal(partial.fixture.evidenceComplete, false);
  assert.equal(partial.expectation.expectedJson.reviewability, 'needs_split');
  assert.equal(partial.expectation.expectedJson.recommendedAction.includes('close'), false);
});

test('release-suite usage is monotonic, does not double count and stops at the aggregate ceiling', () => {
  const budget = new ProductionSuiteBudgetGuard({ maxTokens: 100, wallMs: 1_000, now: () => 10 });
  assert.equal(budget.observeUsage('one', usage(60, 10, 0.004)), null);
  assert.equal(budget.observeUsage('one', usage(50, 5, 0.003)), null);
  assert.match(budget.observeUsage('two', usage(25, 5, null)), /token budget exhausted/);
  assert.equal(budget.recordUsage('one', usage(60, 10, 0.004)), null);

  const snapshot = budget.snapshot();
  assert.equal(snapshot.inputTokens, 85);
  assert.equal(snapshot.outputTokens, 15);
  assert.equal(snapshot.reportedRuns, 2);
  assert.equal(snapshot.estimatedCostUsd, 0.004);
  assert.equal(snapshot.costPartial, true);
});

test('release-suite accounting fails closed when a settled runtime cannot report usage', () => {
  const budget = new ProductionSuiteBudgetGuard();
  assert.match(
    budget.recordUsage('blind-run', {
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: null,
      telemetry: 'unsupported',
    }),
    /cannot report token usage/,
  );
  assert.equal(budget.snapshot().missingRuns, 1);
});

test('release-suite turn timeouts shrink to the aggregate deadline and then fail closed', () => {
  let now = 100;
  const budget = new ProductionSuiteBudgetGuard({ wallMs: 50, now: () => now });
  assert.equal(budget.timeoutFor(500), 50);
  now = 151;
  assert.throws(() => budget.timeoutFor(500), /time budget exhausted/);
  assert.equal(budget.stopped, true);
});

test('a production suite returns immediately, persists progress and finishes after the queued model turn', async () => {
  const fixture = productionServiceFixture();
  const suite = fixture.production.startSuite({ username: 'alice' });
  const available = cases.filter((record) => record.adapterId === 'code.pr-review');
  const plannedRuns = available.reduce((total, record) => total + record.requiredPasses, 0);

  assert.equal(suite.status, 'running');
  assert.equal(fixture.store.getProductionSuite(suite.id).status, 'running');
  assert.equal(fixture.store.getProductionSuite(suite.id).currentCaseId, cases[0].id);
  assert.equal(fixture.store.listProductionRuns('alice').length, 0);
  assert.deepEqual(fixture.capturedLane(), { runnerId: null, harness: null });

  fixture.finishRun();
  await eventually(() => fixture.store.getProductionSuite(suite.id).status === 'completed');
  const completed = fixture.store.getProductionSuite(suite.id);
  assert.equal(completed.completed, plannedRuns);
  assert.equal(completed.currentCaseId, null);
  assert.equal(completed.budget.inputTokens, plannedRuns * 100);
  assert.equal(completed.budget.outputTokens, plannedRuns * 20);
  assert.equal(completed.budget.reportedRuns, plannedRuns);
  assert.equal(fixture.store.listProductionRuns('alice')[0].status, 'passed');
  assert.ok(fixture.broadcasts() >= 4);
  fixture.db.close();
});

test('cancelling a durable suite terminalizes it before stopping queued work', async () => {
  const fixture = productionServiceFixture();
  const suite = fixture.production.startSuite({ username: 'alice' });

  await fixture.production.cancelSuite(suite.id, { username: 'alice' });
  assert.equal(fixture.store.getProductionSuite(suite.id).status, 'cancelled');
  assert.equal(fixture.cancelledQueues(), 1);
  await eventually(() => fixture.store.listProductionRuns('alice').length === 1);
  assert.equal(fixture.store.listProductionRuns('alice')[0].status, 'cancelled');
  assert.equal(fixture.store.getProductionSuite(suite.id).status, 'cancelled');
  fixture.db.close();
});

test('a production suite terminalizes and reaps its child at the live aggregate token limit', async () => {
  const fixture = productionServiceFixture({ inputTokens: 1_000_000, outputTokens: 1 });
  const suite = fixture.production.startSuite({ username: 'alice' });

  fixture.finishRun();
  await eventually(() => fixture.store.getProductionSuite(suite.id).status === 'failed');
  const failed = fixture.store.getProductionSuite(suite.id);
  assert.match(failed.error, /token budget exhausted/);
  assert.equal(failed.budget.inputTokens, 1_000_000);
  assert.equal(failed.budget.outputTokens, 1);
  assert.ok(fixture.stoppedRuns() >= 1);
  await fixture.production.stop();
  fixture.db.close();
});

test('settlement-only usage that crosses the suite ceiling cannot create a green case result', async () => {
  const fixture = productionServiceFixture({ inputTokens: 1_000_000, outputTokens: 1, emitUsage: false });
  const suite = fixture.production.startSuite({ username: 'alice' });

  fixture.finishRun();
  await eventually(() => fixture.store.getProductionSuite(suite.id).status === 'failed');
  await fixture.production.stop();
  const run = fixture.store.listProductionRuns('alice')[0];
  assert.equal(run.status, 'error');
  assert.match(run.error, /token budget exhausted/);
  fixture.db.close();
});

function productionServiceFixture(fixtureOptions = {}) {
  const db = new Database(':memory:');
  for (const migration of migrations) migration.up(db);
  const store = new PlaygroundEvaluationStore(db);
  const descriptor = adapterMeta.get('code.pr-review');
  const adapter = {
    id: 'code.pr-review',
    ...descriptor,
    buildPrompt: () => 'exact production prompt',
    parseResponse: (message) => JSON.parse(message),
  };
  const rows = new Map();
  let resolveRun;
  let rejectRun;
  let broadcastCount = 0;
  let cancelledQueueCount = 0;
  let capturedLane = null;
  let stoppedRunCount = 0;
  let runNumber = 0;
  const orchestrator = {
    userLane: () => ({ runnerId: null, harness: null }),
    laneModels: () => ({ defaultModel: null, pins: {} }),
    taskModelPin: () => 'model-a',
    defaultModelPreference: () => 'model-default',
    runOneShot: (runOptions) => {
      runNumber += 1;
      const runId = `agent-${runNumber}`;
      capturedLane = runOptions.lane;
      runOptions.onQueued?.(`queue-${runNumber}`);
      const record = cases.find((candidate) => runOptions.title === `Production evaluation: ${candidate.name}`);
      const response = responseFor(record);
      const complete = (resolve) => {
        runOptions.onStarted?.(runId);
        rows.set(runId, {
          model: 'model-a',
          runner_id: 'runner-a',
          harness: 'moxxy',
          input_tokens: fixtureOptions.inputTokens ?? 100,
          output_tokens: fixtureOptions.outputTokens ?? 20,
        });
        if (fixtureOptions.emitUsage !== false) runOptions.onUsage?.(runId);
        resolve({ runId, finalMessage: response });
      };
      return new Promise((resolve, reject) => {
        resolveRun = () => complete(resolve);
        rejectRun = reject;
        // Only the first case is held so the test can observe durable in-flight
        // state. Later cases drain normally once the gate has begun.
        if (runNumber > 1) complete(resolve);
      });
    },
    cancelQueued: () => {
      cancelledQueueCount += 1;
      rejectRun?.(new Error('cancelled while queued'));
      return true;
    },
    stopRun: async () => { stoppedRunCount += 1; },
  };
  const production = new ProductionEvaluations({
    store,
    operate: {
      promptEvaluations: {
        descriptors: () => [adapter],
        get: (id) => id === adapter.id ? adapter : undefined,
      },
      orchestrator,
      runsStore: { get: (id) => rows.get(id) },
      usageForRun: (id) => {
        const row = rows.get(id);
        if (!row) return null;
        return {
          inputTokens: row.input_tokens,
          outputTokens: row.output_tokens,
          estimatedCostUsd: fixtureOptions.estimatedCostUsd ?? 0.004,
          telemetry: fixtureOptions.telemetry ?? 'reported',
        };
      },
    },
    isEnabled: (moduleId) => moduleId === 'code',
    broadcast: () => { broadcastCount += 1; },
    log: () => undefined,
  });
  return {
    db,
    store,
    production,
    finishRun: () => resolveRun(),
    broadcasts: () => broadcastCount,
    cancelledQueues: () => cancelledQueueCount,
    stoppedRuns: () => stoppedRunCount,
    capturedLane: () => capturedLane,
  };
}

function usage(inputTokens, outputTokens, estimatedCostUsd) {
  return { inputTokens, outputTokens, estimatedCostUsd, telemetry: 'reported' };
}

function responseFor(record) {
  const value = {};
  for (const path of record.expectation.requiredJsonPaths) setPath(value, path, 'fixture');
  for (const [path, expected] of Object.entries(record.expectation.expectedJson)) {
    setPath(value, path, Array.isArray(expected) ? expected[0] : expected);
  }
  return JSON.stringify(value);
}

function setPath(root, path, value) {
  const parts = path.split('.');
  let current = root;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    const next = parts[index + 1];
    if (/^\d+$/.test(next)) {
      current[part] ??= [];
      const position = Number(next);
      current[part][position] ??= {};
      current = current[part][position];
      index += 1;
    } else {
      current[part] ??= {};
      current = current[part];
    }
  }
  current[parts.at(-1)] = value;
}

async function eventually(predicate) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('condition did not become true');
}
