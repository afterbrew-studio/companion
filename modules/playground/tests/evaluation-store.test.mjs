import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import migrations from '../dist/api/migrations.js';
import { PlaygroundEvaluationStore } from '../dist/api/evaluation-store.js';

const expectation = {
  responseFormat: 'text',
  requiredPhrases: ['evidence'],
  forbiddenPhrases: [],
  requiredJsonPaths: [],
  expectedJson: {},
  maxDurationMs: null,
  maxInputTokens: null,
  maxOutputTokens: null,
};

const productionConfiguration = {
  fingerprint: 'cfg-1',
  task: 'code.pr-review',
  taskModelPin: 'model-a',
  laneRunnerId: null,
  laneHarness: null,
  laneTaskModel: null,
  laneDefaultModel: null,
  daemonDefaultModel: 'model-default',
  actualModel: 'model-a',
  actualRunnerId: null,
  actualHarness: 'moxxy',
};

function evaluationCase(overrides = {}) {
  return {
    id: 'eval-1',
    name: 'Adversarial PR',
    description: 'Must distinguish evidence from claims.',
    prompt: 'Review the fixture.',
    repo: 'acme/app',
    workspaceId: 'ws-a',
    ownerId: 'alice',
    skill: null,
    timeoutMs: 60_000,
    tags: ['prompt-injection'],
    safetyCritical: true,
    expectation,
    revision: 1,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

function fixture() {
  const db = new Database(':memory:');
  for (const migration of migrations) migration.up(db);
  return { db, store: new PlaygroundEvaluationStore(db) };
}

test('repo cases are workspace-visible while scratch cases remain owner-private', () => {
  const { db, store } = fixture();
  store.insertCase(evaluationCase());
  store.insertCase(evaluationCase({ id: 'eval-private', repo: null, workspaceId: null, ownerId: 'bob' }));

  assert.deepEqual(store.listCases('carol', new Set(['ws-a'])).map((record) => record.id), ['eval-1']);
  assert.deepEqual(store.listCases('bob', new Set()).map((record) => record.id), ['eval-private']);
  assert.deepEqual(store.listCases('carol', new Set()).map((record) => record.id), []);
  db.close();
});

test('case updates are compare-and-set revisions and preserve the winning edit', () => {
  const { db, store } = fixture();
  const original = evaluationCase();
  store.insertCase(original);
  const input = {
    name: 'Revised adversarial PR',
    description: original.description,
    prompt: original.prompt,
    repo: original.repo,
    skill: original.skill,
    timeoutMs: original.timeoutMs,
    tags: original.tags,
    safetyCritical: original.safetyCritical,
    expectation: original.expectation,
  };

  const updated = store.updateCase(original.id, 1, input, { workspaceId: 'ws-a', ownerId: 'alice' });
  assert.equal(updated.revision, 2);
  assert.equal(updated.name, 'Revised adversarial PR');
  assert.equal(store.updateCase(original.id, 1, { ...input, name: 'Stale edit' }, { workspaceId: 'ws-a', ownerId: 'alice' }), null);
  assert.equal(store.getCase(original.id).name, 'Revised adversarial PR');
  db.close();
});

test('run history is bounded per case and deletion removes its comparison rows', () => {
  const { db, store } = fixture();
  const record = evaluationCase();
  store.insertCase(record);
  for (let index = 0; index < 55; index += 1) {
    store.insertRun(
      {
        id: `run-${index}`,
        caseId: record.id,
        caseName: record.name,
        caseRevision: record.revision,
        promptVersion: 2,
        runId: `agent-${index}`,
        status: 'passed',
        checks: [{ kind: 'response', label: 'response', passed: true, detail: 'ok' }],
        message: 'evidence',
        error: null,
        durationMs: 1_000,
        inputTokens: 100,
        outputTokens: 20,
        model: 'test-model',
        createdAt: 1_000 + index,
      },
      record,
    );
  }

  const visible = store.listRuns('alice', new Set());
  assert.equal(visible.length, 50);
  assert.equal(visible[0].id, 'run-54');
  assert.equal(visible.at(-1).id, 'run-5');
  assert.equal(store.deleteCase(record.id), true);
  assert.equal(store.listRuns('alice', new Set()).length, 0);
  db.close();
});

test('production replay history is private per maintainer and bounded per case', () => {
  const { db, store } = fixture();
  for (let index = 0; index < 55; index += 1) {
    store.insertProductionRun({
      id: `production-${index}`,
      caseId: 'production.code.review',
      caseName: 'Review regression',
      caseRevision: 1,
      adapterId: 'code.pr-review',
      adapterVersion: 2,
      promptFingerprint: 'prompt-1',
      runId: `agent-${index}`,
      status: 'passed',
      checks: [{ kind: 'production_parser', label: 'parser', passed: true, detail: 'ok' }],
      parsedOutput: { recommendation: 'request_changes' },
      message: '{"recommendation":"request_changes"}',
      error: null,
      durationMs: 1_000,
      inputTokens: 100,
      outputTokens: 20,
      model: 'model-a',
      configuration: productionConfiguration,
      ownerId: 'alice',
      createdAt: 2_000 + index,
    });
  }
  store.insertProductionRun({
    id: 'production-bob',
    caseId: 'production.code.review',
    caseName: 'Review regression',
    caseRevision: 1,
    adapterId: 'code.pr-review',
    adapterVersion: 2,
    promptFingerprint: 'prompt-1',
    runId: 'agent-bob',
    status: 'failed',
    checks: [{ kind: 'production_parser', label: 'parser', passed: false, detail: 'bad' }],
    parsedOutput: null,
    message: 'bad',
    error: null,
    durationMs: 1_000,
    inputTokens: 100,
    outputTokens: 20,
    model: 'model-a',
    configuration: productionConfiguration,
    ownerId: 'bob',
    createdAt: 9_000,
  });

  const alice = store.listProductionRuns('alice');
  assert.equal(alice.length, 50);
  assert.equal(alice[0].id, 'production-54');
  assert.deepEqual(alice[0].parsedOutput, { recommendation: 'request_changes' });
  assert.equal(store.listProductionRuns('bob').length, 1);
  assert.equal(store.listProductionRuns('carol').length, 0);
  db.close();
});

test('production suites are owner-private, single-flight and terminal updates are compare-and-set', () => {
  const { db, store } = fixture();
  const running = {
    id: 'suite-alice',
    ownerId: 'alice',
    status: 'running',
    total: 5,
    completed: 0,
    currentCaseId: null,
    currentCaseName: null,
    caseIds: ['one', 'two', 'three', 'four', 'five'],
    budget: {
      startedAt: 100,
      deadlineAt: 3_600_100,
      maxTokens: 1_000_000,
      inputTokens: 0,
      outputTokens: 0,
      reportedRuns: 0,
      missingRuns: 0,
      estimatedCostUsd: 0,
      costPartial: false,
    },
    error: null,
    createdAt: 100,
    updatedAt: 100,
  };
  store.insertProductionSuite(running);
  store.insertProductionSuite({ ...running, id: 'suite-bob', ownerId: 'bob' });

  assert.throws(
    () => store.insertProductionSuite({ ...running, id: 'suite-alice-duplicate' }),
    /UNIQUE constraint failed/,
  );
  assert.deepEqual(store.listProductionSuites('alice').map((suite) => suite.id), ['suite-alice']);
  assert.deepEqual(store.listProductionSuites('bob').map((suite) => suite.id), ['suite-bob']);
  assert.equal(store.listProductionSuites('carol').length, 0);

  assert.equal(store.updateProductionSuiteProgress('suite-alice', 1, 'two', 'Second case'), true);
  assert.equal(store.getProductionSuite('suite-alice').completed, 1);
  assert.equal(store.updateProductionSuiteBudget('suite-alice', {
    ...running.budget,
    inputTokens: 120,
    outputTokens: 30,
    reportedRuns: 1,
    estimatedCostUsd: 0.004,
  }), true);
  assert.equal(store.getProductionSuite('suite-alice').budget.inputTokens, 120);
  assert.equal(store.finishProductionSuite('suite-alice', 'cancelled', null), true);
  assert.equal(store.updateProductionSuiteProgress('suite-alice', 2, 'three', 'Third case'), false);
  assert.equal(store.updateProductionSuiteBudget('suite-alice', running.budget), false);
  assert.equal(store.finishProductionSuite('suite-alice', 'completed', null), false);
  assert.equal(store.getProductionSuite('suite-alice').status, 'cancelled');

  assert.equal(store.recoverProductionSuites(), 1);
  const recovered = store.getProductionSuite('suite-bob');
  assert.equal(recovered.status, 'interrupted');
  assert.match(recovered.error, /restarted/);
  db.close();
});

test('the production-suite budget migration is additive and idempotent', () => {
  const db = new Database(':memory:');
  for (const migration of migrations.slice(0, 3)) migration.up(db);
  migrations[3].up(db);
  migrations[3].up(db);
  const columns = db
    .prepare(`PRAGMA table_info(playground_production_evaluation_suites)`)
    .all()
    .filter((column) => column.name === 'budget');
  assert.equal(columns.length, 1);
  db.close();
});

test('production history uses insertion order when millisecond timestamps tie', () => {
  const { db, store } = fixture();
  const baseRun = {
    id: 'same-ms-first',
    caseId: 'production.code.review',
    caseName: 'Review regression',
    caseRevision: 1,
    adapterId: 'code.pr-review',
    adapterVersion: 2,
    promptFingerprint: 'prompt-1',
    runId: 'agent-first',
    status: 'failed',
    checks: [],
    parsedOutput: null,
    message: '{}',
    error: null,
    durationMs: 1,
    inputTokens: 1,
    outputTokens: 1,
    model: 'model-a',
    configuration: productionConfiguration,
    ownerId: 'alice',
    createdAt: 5_000,
  };
  store.insertProductionRun(baseRun);
  store.insertProductionRun({ ...baseRun, id: 'same-ms-second', runId: 'agent-second', status: 'passed' });
  assert.deepEqual(store.listProductionRuns('alice').map((run) => run.id), ['same-ms-second', 'same-ms-first']);
  db.close();
});
