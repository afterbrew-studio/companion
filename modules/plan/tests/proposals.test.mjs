import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
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

test('proposal analysis bounds verbose summaries before persistence', () => {
  const parsed = parseAnalysis(JSON.stringify({ ...richAnalysis, summary: 'x'.repeat(10_000) }));
  assert.equal(parsed.summary.length, 4_000);
  assert.throws(() => parseAnalysis(JSON.stringify({ ...richAnalysis, summary: 'x'.repeat(20_001) })));
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
    { proposals: proposalsStore, repos: { get: () => ({ default_branch: 'main' }) } },
    { runOneShot: async () => ({ runId: 'run-invalid', finalMessage: '{ not valid JSON' }) },
    { createGoalRun: () => { throw new Error('must not implement'); } },
    {
      hasClone: () => true,
      withBaseWorktree: async (_repo, _id, _branch, fn) => fn('/tmp/repo'),
    },
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

test('proposal status counters do not materialise large bodies or analyses', () => {
  const { db, proposalsStore } = proposalStore();
  const now = Date.now();
  proposalsStore.insert({
    id: 'prop-heavy', workspaceId: 'ws-1', repo: 'owner/repo', title: 'Heavy', body: 'x'.repeat(250_000),
    status: 'analyzed', analysis: richAnalysis, analysisRunId: 'run-1', implementRunId: null,
    branch: null, prUrl: null, createdAt: now, updatedAt: now,
  });
  proposalsStore.insert({
    id: 'prop-other', workspaceId: 'ws-2', repo: 'owner/other', title: 'Other', body: 'body',
    status: 'draft', analysis: null, analysisRunId: null, implementRunId: null,
    branch: null, prUrl: null, createdAt: now, updatedAt: now,
  });

  assert.deepEqual(proposalsStore.listStatusesByWorkspace('ws-1'), [{ id: 'prop-heavy', status: 'analyzed' }]);
  db.close();
});

test('implementation run transitions resolve one proposal directly', () => {
  const { db, proposalsStore } = proposalStore();
  const now = Date.now();
  for (let index = 0; index < 40; index += 1) {
    proposalsStore.insert({
      id: `prop-run-${index}`,
      workspaceId: 'ws-1',
      repo: 'owner/repo',
      title: `Proposal ${index}`,
      body: 'x'.repeat(50_000),
      status: index === 19 ? 'implementing' : 'draft',
      analysis: null,
      analysisRunId: null,
      implementRunId: index === 19 ? 'run-target' : null,
      branch: null,
      prUrl: null,
      createdAt: now + index,
      updatedAt: now + index,
    });
  }
  const broadcasts = [];
  const service = new Proposals(
    { proposals: proposalsStore },
    {},
    {},
    {},
    (message) => broadcasts.push(message),
  );

  assert.deepEqual(proposalsStore.getByImplementRunId('run-target'), {
    id: 'prop-run-19',
    status: 'implementing',
  });
  service.onRunReview('run-target');
  assert.equal(proposalsStore.get('prop-run-19').status, 'review');
  service.onRunFailed('run-target');
  assert.equal(proposalsStore.get('prop-run-19').status, 'failed');
  service.onRunFailed('run-missing');
  assert.equal(broadcasts.length, 2);
  db.close();
});

test('proposal cards are server-paged and search bodies without returning them', () => {
  const { db, proposalsStore } = proposalStore();
  for (let index = 0; index < 75; index += 1) {
    proposalsStore.insert({
      id: `prop-${String(index).padStart(3, '0')}`,
      workspaceId: 'ws-1',
      repo: index % 2 === 0 ? 'owner/repo-a' : 'owner/repo-b',
      title: `Proposal ${index}`,
      body: index === 31 ? `${'z'.repeat(250_000)} body-only-marker` : `Body ${index}`,
      status: index % 3 === 0 ? 'analyzed' : 'draft',
      analysis: index % 3 === 0 ? richAnalysis : null,
      analysisRunId: index % 3 === 0 ? `run-${index}` : null,
      implementRunId: null,
      branch: null,
      prUrl: null,
      createdAt: index,
      updatedAt: index,
    });
  }

  const page = proposalsStore.listWorkspacePage('ws-1', { limit: 20, offset: 50 });
  assert.equal(page.total, 75);
  assert.equal(page.proposals.length, 20);
  assert.equal(page.proposals[0].id, 'prop-024');
  assert.equal(page.proposals.at(-1).id, 'prop-005');
  assert.equal(Object.hasOwn(page.proposals[0], 'body'), false);
  assert.equal(Object.hasOwn(page.proposals[0], 'analysis'), false);

  const match = proposalsStore.listWorkspacePage('ws-1', { q: 'body-only-marker' });
  assert.equal(match.total, 1);
  assert.equal(match.proposals[0].id, 'prop-031');
  assert.equal(match.proposals[0].bodyPreview.length, 500);
  assert.equal(match.proposals[0].bodyLength, 250_017);
  const analyzed = proposalsStore.listWorkspacePage('ws-1', {
    repo: 'owner/repo-a', status: 'analyzed', limit: 100,
  });
  assert.ok(analyzed.total > 0);
  assert.ok(analyzed.proposals.every((proposal) => proposal.analysisFeasibility === 'high'));
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
