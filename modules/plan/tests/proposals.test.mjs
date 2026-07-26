import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { parseAnalysis, Proposals } from '../dist/api/proposals.js';
import { normalizeProposalAnalysis, ProposalsStore } from '../dist/api/proposals-store.js';

const richAnalysis = {
  summary: 'The feature fits the existing architecture.',
  feasibility: 'high',
  steps: ['Add contract', 'Implement service'],
  touchedAreas: ['modules/analytics'],
  risks: ['Privacy'],
  architecture: ['Keep writes in the analytics owner module'],
  dataModelAndMigrations: ['Add an additive views table'],
  apiAndUi: ['Expose aggregate counts'],
  authorizationPrivacySecurity: ['Do not expose viewer identities'],
  tests: ['Test anonymous aggregation'],
  dependencies: [],
  costs: ['SQLite growth'],
  mvp: ['Total view count'],
  later: ['Cohorts'],
  openDecisions: [],
};

test('rich proposal analysis is strictly parsed', () => {
  assert.deepEqual(parseAnalysis(JSON.stringify(richAnalysis)), richAnalysis);
  assert.throws(() => parseAnalysis(JSON.stringify({ ...richAnalysis, tests: undefined })));
});

test('rich proposal analysis caps over-detailed model lists instead of failing', () => {
  const tests = Array.from({ length: 23 }, (_, index) => `Test case ${index + 1}`);
  const parsed = parseAnalysis(JSON.stringify({ ...richAnalysis, tests }));
  assert.equal(parsed.tests.length, 20);
  assert.deepEqual(parsed.tests, tests.slice(0, 20));
  assert.throws(() => parseAnalysis(JSON.stringify({ ...richAnalysis, tests: Array.from({ length: 101 }, () => 'test') })));
});

test('legacy analyses are normalized with empty rich sections', () => {
  const normalized = normalizeProposalAnalysis({
    summary: 'Old result', feasibility: 'medium', steps: ['One'], touchedAreas: ['x'], risks: ['y'],
  });
  assert.equal(normalized.summary, 'Old result');
  assert.deepEqual(normalized.architecture, []);
  assert.deepEqual(normalized.tests, []);
  assert.deepEqual(normalized.openDecisions, []);
});

test('editing a proposal resets its analysis without starting implementation', () => {
  const { db, proposalsStore } = proposalStore();
  const now = Date.now();
  proposalsStore.insert({
    id: 'prop-1', workspaceId: 'ws-1', repo: 'owner/repo', title: 'Old', body: 'Old body',
    status: 'analyzed', analysis: richAnalysis, analysisRunId: 'run-1', implementRunId: null,
    branch: null, prUrl: null, createdAt: now, updatedAt: now,
  });
  const service = new Proposals(
    { proposals: proposalsStore },
    { runOneShot: () => { throw new Error('must not run'); } },
    { createGoalRun: () => { throw new Error('must not implement'); } },
    {},
    () => undefined,
  );
  const updated = service.update('prop-1', { title: 'New', body: 'New body' });
  assert.equal(updated.status, 'draft');
  assert.equal(updated.analysis, null);
  assert.equal(updated.analysisRunId, null);
  assert.equal(updated.implementRunId, null);
  db.close();
});

test('invalid model output stores failure while returning a user-safe error', async () => {
  const { db, proposalsStore } = proposalStore();
  const now = Date.now();
  proposalsStore.insert({
    id: 'prop-invalid', workspaceId: 'ws-1', repo: 'owner/repo', title: 'Analyze me', body: 'Body',
    status: 'draft', analysis: null, analysisRunId: null, implementRunId: null,
    branch: null, prUrl: null, createdAt: now, updatedAt: now,
  });
  const service = new Proposals(
    { proposals: proposalsStore },
    { runOneShot: async () => ({ runId: 'run-invalid', finalMessage: '{ not valid JSON' }) },
    { createGoalRun: () => { throw new Error('must not implement'); } },
    { hasClone: () => true, cloneDir: () => '/tmp/repo' },
    () => undefined,
  );
  await assert.rejects(service.analyze('prop-invalid', 'admin'), /did not match the expected structure/);
  assert.equal(proposalsStore.get('prop-invalid').status, 'failed');
  db.close();
});

test('Ideas proposal analysis reuses its repository snapshot without checkout access', async () => {
  const { db, proposalsStore } = proposalStore();
  const now = Date.now();
  proposalsStore.insert({
    id: 'prop-cached', workspaceId: 'ws-1', repo: 'owner/repo', title: 'Analyze from cache', body: 'Body',
    status: 'draft', analysis: null, analysisRunId: null, implementRunId: null,
    branch: null, prUrl: null, createdAt: now, updatedAt: now,
  });
  let runInput;
  let completion;
  let checkoutCalls = 0;
  const service = new Proposals(
    { proposals: proposalsStore },
    {
      runOneShot: async (input) => {
        runInput = input;
        input.onStarted?.('run-cached');
        return { runId: 'run-cached', finalMessage: JSON.stringify(richAnalysis) };
      },
    },
    { createGoalRun: () => { throw new Error('must not implement'); } },
    {
      hasClone: () => { checkoutCalls += 1; throw new Error('must not inspect checkout'); },
      cloneDir: () => { checkoutCalls += 1; throw new Error('must not resolve checkout'); },
    },
    () => undefined,
  );

  const result = await service.analyze('prop-cached', 'alice', {
    repositorySnapshot: JSON.stringify({ summary: 'React application', architecture: ['Feature modules'] }),
    documentation: [{ title: 'Feature', content: 'Expected user behavior' }],
    onCompleted: (metrics) => { completion = metrics; },
  });

  assert.equal(result.status, 'analyzed');
  assert.equal(checkoutCalls, 0);
  assert.equal('cwd' in runInput, false);
  assert.match(runInput.prompt, /repository discovery is already complete/);
  assert.match(runInput.prompt, /React application/);
  assert.match(runInput.prompt, /Do not inspect, search, clone/);
  assert.equal(completion.runId, 'run-cached');
  assert.equal(completion.contextMode, 'cached_snapshot');
  assert.equal(completion.promptChars, runInput.prompt.length);
  db.close();
});

test('cached proposal analysis rejects an oversized prompt before starting a run', async () => {
  const { db, proposalsStore } = proposalStore();
  const now = Date.now();
  proposalsStore.insert({
    id: 'prop-oversized', workspaceId: 'ws-1', repo: 'owner/repo', title: 'Oversized', body: 'x'.repeat(79_000),
    status: 'draft', analysis: null, analysisRunId: null, implementRunId: null,
    branch: null, prUrl: null, createdAt: now, updatedAt: now,
  });
  let runs = 0;
  const service = new Proposals(
    { proposals: proposalsStore },
    { runOneShot: async () => { runs += 1; throw new Error('must not run'); } },
    { createGoalRun: () => { throw new Error('must not implement'); } },
    {},
    () => undefined,
  );

  await assert.rejects(
    service.analyze('prop-oversized', 'alice', { repositorySnapshot: JSON.stringify({ summary: 'cached' }) }),
    /cached proposal analysis prompt exceeds/,
  );
  assert.equal(runs, 0);
  assert.equal(proposalsStore.get('prop-oversized').status, 'draft');
  db.close();
});

function proposalStore() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE proposals (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, repo TEXT NOT NULL,
      title TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, analysis TEXT,
      analysis_run_id TEXT, implement_run_id TEXT, branch TEXT, pr_url TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  return { db, proposalsStore: new ProposalsStore(db) };
}
