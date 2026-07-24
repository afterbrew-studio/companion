import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { assertPlannerTransition } from '../dist/api/planner-machine.js';
import { parseArtifactBundle, parseClarification } from '../dist/api/prompts.js';
import { PlannerService } from '../dist/api/planner-service.js';
import { PlannerRevisionConflict, PlannerStore } from '../dist/api/planner-store.js';

const brief = {
  problem: 'People cannot see listing performance.',
  audience: ['Listing owners'],
  goal: 'Show useful view counts.',
  mvp: ['Count listing views'],
  outOfScope: ['Paid analytics vendor'],
  assumptions: ['Anonymous aggregation is enough'],
  risks: ['Privacy'],
  openDecisions: [],
};

function question(recommended = 0) {
  return {
    prompt: 'How long should data be retained?',
    whyItMatters: 'It changes privacy and storage cost.',
    options: [0, 1, 2].map((index) => ({
      label: `${index + 1} months`,
      description: `Retain data for ${index + 1} months.`,
      recommended: index === recommended,
    })),
  };
}

test('clarification parser assigns server ids and accepts at most three well-formed questions', () => {
  let id = 0;
  const parsed = parseClarification(JSON.stringify({ summary: 'Clear enough.', brief, questions: [question(), question(1), question(2)] }), (prefix) => `${prefix}-${++id}`);
  assert.equal(parsed.questions.length, 3);
  assert.equal(parsed.questions[0].id, 'pq-1');
  assert.equal(parsed.questions[0].options.length, 3);
  assert.equal(parsed.questions[0].options.filter((option) => option.recommended).length, 1);
  assert.ok(parsed.questions[0].options.every((option) => option.id.startsWith('po-')));
});

test('clarification parser safely caps verbose model brief lists', () => {
  const verboseBrief = {
    ...brief,
    mvp: Array.from({ length: 24 }, (_, index) => `MVP item ${index + 1}`),
    assumptions: Array.from({ length: 22 }, (_, index) => `Assumption ${index + 1}`),
  };
  const parsed = parseClarification(JSON.stringify({ summary: 'Clear enough.', brief: verboseBrief, questions: [] }));
  assert.equal(parsed.brief.mvp.length, 20);
  assert.equal(parsed.brief.mvp[19], 'MVP item 20');
  assert.equal(parsed.brief.assumptions.length, 20);
});

test('clarification parser retains a hard safety limit for model brief lists', () => {
  const runawayBrief = { ...brief, mvp: Array.from({ length: 101 }, (_, index) => `MVP item ${index + 1}`) };
  assert.throws(() => parseClarification(JSON.stringify({ summary: 'Too verbose.', brief: runawayBrief, questions: [] })));
});

test('clarification parser rejects too many questions, wrong option counts and ambiguous recommendations', () => {
  assert.throws(() => parseClarification(JSON.stringify({ summary: 'x', brief, questions: [question(), question(), question(), question()] })));
  assert.throws(() => parseClarification(JSON.stringify({ summary: 'x', brief, questions: [{ ...question(), options: question().options.slice(0, 2) }] })));
  const ambiguous = question();
  ambiguous.options[1].recommended = true;
  assert.throws(() => parseClarification(JSON.stringify({ summary: 'x', brief, questions: [ambiguous] })));
  assert.throws(() => parseClarification('null'));
  assert.throws(() => parseClarification('not json'));
});

test('artifact bundle parsing is strict and never fabricates a missing model result', () => {
  const draft = { title: 'Listing analytics', content: 'A sufficiently detailed markdown artifact describing listing analytics.' };
  assert.deepEqual(parseArtifactBundle(JSON.stringify({ documentation: draft, specification: draft, implementationPlan: draft })).documentation, draft);
  assert.throws(() => parseArtifactBundle(''));
  assert.throws(() => parseArtifactBundle(JSON.stringify({ documentation: draft, specification: draft })));
});

test('planner state machine accepts the workflow and rejects skips or edits after launch', () => {
  assert.doesNotThrow(() => assertPlannerTransition('idea', 'draft', 'clarification', 'working'));
  assert.doesNotThrow(() => assertPlannerTransition('tasks_review', 'working', 'launched', 'completed'));
  assert.throws(() => assertPlannerTransition('idea', 'draft', 'tasks_review', 'waiting_for_user'));
  assert.throws(() => assertPlannerTransition('launched', 'completed', 'tasks_review', 'waiting_for_user'));
});

function storeFixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE planner_sessions (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, repo TEXT NOT NULL, branch TEXT NOT NULL,
      author TEXT NOT NULL, title TEXT NOT NULL, idea TEXT NOT NULL, step TEXT NOT NULL,
      status TEXT NOT NULL, revision INTEGER NOT NULL, active_action TEXT, last_error TEXT,
      brief_json TEXT NOT NULL, questions_json TEXT NOT NULL, answers_json TEXT NOT NULL,
      messages_json TEXT NOT NULL, artifacts_json TEXT, pending_revision_json TEXT,
      confirmations_json TEXT NOT NULL, doc_id TEXT, spec_id TEXT, proposal_id TEXT,
      analysis_json TEXT, analysis_run_id TEXT, refinement_id TEXT, task_ids_json TEXT NOT NULL,
      active_queue_id TEXT, active_run_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE planner_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, kind TEXT NOT NULL,
      detail_json TEXT NOT NULL, created_at INTEGER NOT NULL
    );
  `);
  return { db, store: new PlannerStore(db) };
}

function session() {
  const now = Date.now();
  return {
    id: 'idea-1', workspaceId: 'ws-1', repo: 'owner/repo', branch: 'main', author: 'alice',
    title: 'Analytics', idea: 'Add analytics', step: 'idea', status: 'draft', revision: 0,
    activeAction: null, lastError: null, brief, questions: [], answers: [], messages: [], artifacts: null,
    pendingRevision: null, confirmations: { brief: false, artifacts: false, analysis: false, launch: false },
    docId: null, specId: null, proposalId: null, analysis: null, analysisRunId: null,
    refinementId: null, taskIds: [], activeQueueId: null, activeRunId: null, createdAt: now, updatedAt: now,
  };
}

const analysis = {
  summary: 'The feature is feasible.',
  feasibility: 'high',
  steps: ['Store view events'],
  touchedAreas: ['api', 'web'],
  risks: ['Privacy'],
  architecture: ['Keep aggregation server-side'],
  dataModelAndMigrations: ['Add an additive views table'],
  apiAndUi: ['Expose aggregate counts'],
  authorizationPrivacySecurity: ['Enforce workspace access'],
  tests: ['Test aggregation and permissions'],
  dependencies: [],
  costs: ['Database growth'],
  mvp: ['Total view count'],
  later: ['Time-series charts'],
  openDecisions: [],
};

function createService(store, overrides = {}) {
  const docs = new Map();
  const specs = new Map();
  const proposals = new Map();
  const plan = {
    docs: {
      create: (workspaceId, fields) => {
        const record = { id: 'doc-1', workspaceId, ...fields };
        docs.set(record.id, record);
        return record;
      },
      get: (id) => docs.get(id),
    },
    specs: {
      create: (workspaceId, repo, title, content) => {
        const record = { id: 'spec-1', workspaceId, repo, title, content };
        specs.set(record.id, record);
        return record;
      },
      get: (id) => specs.get(id),
    },
    proposals: {
      create: (workspaceId, repo, title, body) => {
        const record = { id: 'prop-1', workspaceId, repo, title, body, analysis: null };
        proposals.set(record.id, record);
        return record;
      },
      analyze: async (id) => ({ ...proposals.get(id), analysis, analysisRunId: 'run-analysis' }),
      list: () => [],
    },
    ...overrides.plan,
  };
  const refinement = {
    importAll: () => undefined,
    get: () => ({ items: [] }),
    ...overrides.refinement,
  };
  const service = new PlannerService(
    store,
    plan,
    refinement,
    { listBoard: () => ({ config: {}, workers: [] }) },
    { repos: { get: () => undefined, inWorkspace: () => false } },
    overrides.operate ?? { orchestrator: {}, checkouts: {} },
    () => undefined,
  );
  return { service, plan, docs, specs, proposals };
}

async function waitFor(read, predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for planner state');
}

test('store enforces expectedRevision and leaves a useful 409 payload source', () => {
  const { db, store } = storeFixture();
  store.insert(session());
  const updated = store.update('idea-1', { step: 'clarification', status: 'working', activeAction: 'clarifying' }, { expectedRevision: 0 });
  assert.equal(updated.revision, 1);
  assert.throws(() => store.update('idea-1', { title: 'stale' }, { expectedRevision: 0 }), (error) => {
    assert.ok(error instanceof PlannerRevisionConflict);
    assert.equal(error.current.revision, 1);
    return true;
  });
  assert.equal(store.get('idea-1').title, 'Analytics');
  db.close();
});

test('boot recovery makes interrupted work retryable without losing linked artifacts', () => {
  const { db, store } = storeFixture();
  store.insert(session());
  store.update('idea-1', { step: 'clarification', status: 'working', activeAction: 'clarifying', docId: 'doc-1', activeRunId: 'run-1' });
  assert.equal(store.resetDangling(), 1);
  const recovered = store.get('idea-1');
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.activeRunId, null);
  assert.equal(recovered.docId, 'doc-1');
  assert.match(recovered.lastError, /restart/);
  db.close();
});

test('artifact retry keeps successful ids and creates only the missing records', async () => {
  const { db, store } = storeFixture();
  const draft = { title: 'Listing analytics', content: 'A detailed artifact for listing analytics and its implementation.' };
  store.insert({
    ...session(),
    step: 'artifacts_review',
    status: 'waiting_for_user',
    artifacts: { documentation: draft, specification: draft, implementationPlan: draft },
  });

  let docCreates = 0;
  let specCreates = 0;
  let proposalCreates = 0;
  const docs = new Map();
  const specs = new Map();
  const proposals = new Map();
  const { service } = createService(store, {
    plan: {
      docs: {
        create: (workspaceId, fields) => {
          docCreates += 1;
          const record = { id: 'doc-1', workspaceId, ...fields };
          docs.set(record.id, record);
          return record;
        },
        get: (id) => docs.get(id),
      },
      specs: {
        create: (workspaceId, repo, title, content) => {
          specCreates += 1;
          if (specCreates === 1) throw new Error('temporary specification failure');
          const record = { id: 'spec-1', workspaceId, repo, title, content };
          specs.set(record.id, record);
          return record;
        },
        get: (id) => specs.get(id),
      },
      proposals: {
        create: (workspaceId, repo, title, body) => {
          proposalCreates += 1;
          const record = { id: 'prop-1', workspaceId, repo, title, body, analysis: null };
          proposals.set(record.id, record);
          return record;
        },
        analyze: async (id) => ({ ...proposals.get(id), analysis, analysisRunId: 'run-analysis' }),
        list: () => [],
      },
    },
  });

  service.createArtifacts('idea-1', 0, 'alice');
  const failed = await waitFor(() => store.get('idea-1'), (value) => value?.status === 'failed');
  assert.equal(failed.docId, 'doc-1');
  assert.equal(failed.specId, null);
  assert.equal(failed.proposalId, null);

  service.retry('idea-1', failed.revision, 'alice');
  const completed = await waitFor(() => store.get('idea-1'), (value) => value?.step === 'analysis_review');
  assert.equal(completed.status, 'waiting_for_user');
  assert.equal(docCreates, 1);
  assert.equal(specCreates, 2);
  assert.equal(proposalCreates, 1);
  db.close();
});

test('double final confirmation imports once with queue enabled and returns the launched session', () => {
  const { db, store } = storeFixture();
  store.insert({
    ...session(),
    step: 'tasks_review',
    status: 'waiting_for_user',
    refinementId: 'ref-1',
  });
  let imports = 0;
  let importArgs;
  const { service } = createService(store, {
    refinement: {
      importAll: (...args) => {
        imports += 1;
        importArgs = args;
      },
      get: () => ({
        refinement: { id: 'ref-1', workspaceId: 'ws-1', repo: 'owner/repo' },
        items: [{ id: 'ri-1', taskId: 'task-1' }],
      }),
    },
  });

  const launched = service.launch('idea-1', 0, 'alice');
  const repeated = service.launch('idea-1', 0, 'alice');
  assert.equal(imports, 1);
  assert.deepEqual(importArgs, ['ref-1', 'alice', true, 'main']);
  assert.deepEqual(launched.taskIds, ['task-1']);
  assert.equal(repeated.revision, launched.revision);
  assert.equal(repeated.status, 'completed');
  db.close();
});

test('stop and cancel persist terminal intent before interrupting queued or running work', async () => {
  const { db, store } = storeFixture();
  store.insert({
    ...session(),
    step: 'clarification',
    status: 'working',
    activeAction: 'clarifying',
    activeQueueId: 'queue-1',
  });
  store.insert({
    ...session(),
    id: 'idea-2',
    step: 'clarification',
    status: 'working',
    activeAction: 'clarifying',
    activeRunId: 'run-1',
  });
  const cancelledQueues = [];
  const stoppedRuns = [];
  const { service } = createService(store, {
    operate: {
      orchestrator: {
        cancelQueued: (id) => cancelledQueues.push(id),
        stopRun: async (id) => stoppedRuns.push(id),
      },
      checkouts: {},
    },
  });

  const stopped = await service.stop('idea-1', 0);
  const cancelled = await service.cancel('idea-2', 0);
  assert.equal(stopped.status, 'failed');
  assert.match(stopped.lastError, /retried/);
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(cancelledQueues, ['queue-1']);
  assert.deepEqual(stoppedRuns, ['run-1']);
  db.close();
});
