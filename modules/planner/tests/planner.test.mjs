import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { assertPlannerTransition } from '../dist/api/planner-machine.js';
import { discussionPrompt, parseArtifactBundle, parseClarification, parsePlannerDiscussion, parsePlannerRevision } from '../dist/api/prompts.js';
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

function storedQuestion() {
  const raw = question();
  return {
    id: 'pq-current',
    prompt: raw.prompt,
    whyItMatters: raw.whyItMatters,
    options: raw.options.map((option, index) => ({ id: `po-${index + 1}`, ...option })),
  };
}

function storedAnswer(index) {
  return {
    questionId: `pq-old-${index}`,
    question: `Previous question ${index}`,
    optionId: null,
    value: `Previous answer ${index}`,
    createdAt: Date.now() - index,
  };
}

function seedClarificationRounds(db, count) {
  const insert = db.prepare(`
    INSERT INTO planner_events (session_id, kind, detail_json, created_at)
    VALUES ('idea-1', 'clarification_answered', '{}', ?)
  `);
  for (let index = 0; index < count; index += 1) insert.run(Date.now() - count + index);
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

test('discussion parser distinguishes explanations, changes and one structured decision', () => {
  const discussionSession = { analysis: null };
  const explanation = parsePlannerDiscussion(JSON.stringify({
    intent: 'explanation', answer: 'These are implementation findings, not tasks.', references: ['architecture'], changeInstruction: null, clarification: null,
  }), discussionSession);
  assert.equal(explanation.intent, 'explanation');
  assert.equal(explanation.changeInstruction, null);
  assert.deepEqual(explanation.references[0], {
    context: 'architecture', location: 'Architecture and integration', label: 'Architecture', count: 0,
  });

  const change = parsePlannerDiscussion(JSON.stringify({
    intent: 'change_request', answer: 'I will prepare a smaller MVP.', references: ['mvp'], changeInstruction: 'Reduce the MVP to five essential capabilities.', clarification: null,
  }), discussionSession);
  assert.equal(change.intent, 'change_request');
  assert.match(change.changeInstruction, /five essential/);

  let id = 0;
  const clarification = parsePlannerDiscussion(JSON.stringify({
    intent: 'clarification_needed',
    answer: 'I need to know which list should be shorter.',
    references: [],
    changeInstruction: null,
    clarification: { question: 'What should be reduced?', options: question().options },
  }), discussionSession, (prefix) => `${prefix}-${++id}`);
  assert.equal(clarification.clarification.options.length, 3);
  assert.equal(clarification.clarification.options.filter((option) => option.recommended).length, 1);
  assert.ok(clarification.clarification.options.every((option) => option.id.startsWith('pdo-')));

  assert.throws(() => parsePlannerDiscussion(JSON.stringify({
    intent: 'clarification_needed', answer: 'Choose.', changeInstruction: null,
    references: [],
    clarification: { question: 'Which?', options: question().options.slice(0, 2) },
  }), discussionSession));
  assert.throws(() => parsePlannerDiscussion(JSON.stringify({
    intent: 'explanation', answer: 'Look in a section that does not exist.', references: ['behavior_specification'], changeInstruction: null, clarification: null,
  }), discussionSession));
});

test('revision parser requires one coherent brief and planning bundle', () => {
  const draft = { title: 'Listing analytics', content: 'A sufficiently detailed markdown artifact describing listing analytics.' };
  const artifacts = { documentation: draft, specification: draft, implementationPlan: draft };
  const revision = parsePlannerRevision(JSON.stringify({ summary: 'Reduced the MVP.', brief: { ...brief, mvp: ['One', 'Two'] }, artifacts }));
  assert.deepEqual(revision.brief.mvp, ['One', 'Two']);
  assert.throws(() => parsePlannerRevision(JSON.stringify({ summary: 'Missing brief.', artifacts })));
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
      target_branch TEXT NOT NULL DEFAULT '',
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
    id: 'idea-1', workspaceId: 'ws-1', repo: 'owner/repo', branch: 'main', targetBranch: 'main', author: 'alice',
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
  const notifications = [];
  const plan = {
    docs: {
      create: (workspaceId, fields) => {
        const record = { id: 'doc-1', workspaceId, ...fields };
        docs.set(record.id, record);
        return record;
      },
      get: (id) => docs.get(id),
      update: (id, fields) => {
        const current = docs.get(id);
        if (!current) throw new Error('doc not found');
        const record = { ...current, ...fields };
        docs.set(id, record);
        return record;
      },
    },
    specs: {
      create: (workspaceId, repo, title, content) => {
        const record = { id: 'spec-1', workspaceId, repo, title, content };
        specs.set(record.id, record);
        return record;
      },
      get: (id) => specs.get(id),
      update: (id, fields) => {
        const current = specs.get(id);
        if (!current) throw new Error('spec not found');
        const record = { ...current, ...fields };
        specs.set(id, record);
        return record;
      },
    },
    proposals: {
      create: (workspaceId, repo, title, body) => {
        const record = { id: 'prop-1', workspaceId, repo, title, body, analysis: null };
        proposals.set(record.id, record);
        return record;
      },
      update: (id, fields) => {
        const current = proposals.get(id);
        if (!current) throw new Error('proposal not found');
        const record = { ...current, ...fields };
        proposals.set(id, record);
        return record;
      },
      analyze: async (id) => ({ ...proposals.get(id), analysis: overrides.proposalAnalysis ?? analysis, analysisRunId: 'run-analysis' }),
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
    overrides.notify ?? { emit: (notification) => notifications.push(notification) },
    () => undefined,
  );
  return { service, plan, docs, specs, proposals, notifications };
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

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('clarification persists submitted answers and includes them in the next planning prompt', async () => {
  const { db, store } = storeFixture();
  store.insert(session());
  const prompts = [];
  const outputs = [
    JSON.stringify({ summary: 'One decision is needed.', brief, questions: [question()] }),
    JSON.stringify({ summary: 'The brief is ready.', brief, questions: [] }),
  ];
  const { service } = createService(store, {
    operate: {
      checkouts: { clone: async () => undefined, cloneDir: () => '/tmp/planner-test' },
      orchestrator: { runOneShot: async (options) => {
        prompts.push(options.prompt);
        return { runId: `run-${prompts.length}`, finalMessage: outputs.shift() ?? null };
      } },
    },
  });

  service.startClarification('idea-1', 0, 'alice');
  const waiting = await waitFor(() => store.get('idea-1'), (value) => value?.status === 'waiting_for_user');
  const activeQuestion = waiting.questions[0];
  const selected = activeQuestion.options[0];
  service.answer('idea-1', waiting.revision, {
    answers: [{ questionId: activeQuestion.id, optionId: selected.id }],
  }, 'alice');
  const ready = await waitFor(() => store.get('idea-1'), (value) => value?.step === 'scope_review');

  assert.equal(ready.answers.length, 1);
  assert.equal(ready.answers[0].question, activeQuestion.prompt);
  assert.equal(ready.answers[0].value, selected.label);
  assert.ok(prompts[1].includes(`${activeQuestion.prompt}: ${selected.label}`));
  db.close();
});

test('planner checkpoints raise actionable inbox notifications with a direct idea link', async () => {
  const { db, store } = storeFixture();
  store.insert(session());
  const outputs = [
    JSON.stringify({ summary: 'One decision is needed.', brief, questions: [question()] }),
    JSON.stringify({ summary: 'The brief is ready.', brief, questions: [] }),
  ];
  const { service, notifications } = createService(store, {
    operate: {
      checkouts: { clone: async () => undefined, cloneDir: () => '/tmp/planner-test' },
      orchestrator: { runOneShot: async () => ({ finalMessage: outputs.shift() ?? null }) },
    },
  });

  service.startClarification('idea-1', 0, 'alice');
  const questionsReady = await waitFor(() => store.get('idea-1'), (value) => value?.questions.length === 1);
  assert.deepEqual(notifications[0], {
    kind: 'action_required',
    workspaceId: 'ws-1',
    repo: 'owner/repo',
    title: 'Your idea needs answers',
    body: 'Analytics: 1 decision is ready for you.',
    href: '#/ideas/idea-1',
  });

  const activeQuestion = questionsReady.questions[0];
  service.answer('idea-1', questionsReady.revision, {
    answers: [{ questionId: activeQuestion.id, optionId: activeQuestion.options[0].id }],
  }, 'alice');
  await waitFor(() => store.get('idea-1'), (value) => value?.step === 'scope_review');
  assert.equal(notifications.length, 2);
  assert.equal(notifications[1].title, 'Review the first release');
  assert.equal(notifications[1].href, '#/ideas/idea-1');
  db.close();
});

test('planner failures create one error notification without replacing the failed state', async () => {
  const { db, store } = storeFixture();
  store.insert(session());
  const { service, notifications } = createService(store, {
    operate: {
      checkouts: { clone: async () => undefined, cloneDir: () => '/tmp/planner-test' },
      orchestrator: { runOneShot: async () => ({ finalMessage: null }) },
    },
  });

  service.startClarification('idea-1', 0, 'alice');
  const failed = await waitFor(() => store.get('idea-1'), (value) => value?.status === 'failed');
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].kind, 'error');
  assert.equal(notifications[0].href, '#/ideas/idea-1');
  assert.match(notifications[0].body, /ended without a response/);
  assert.match(failed.lastError, /ended without a response/);
  db.close();
});

test('the fifth clarification round consolidates its answers and cannot produce more questions', async () => {
  const { db, store } = storeFixture();
  const currentQuestion = storedQuestion();
  store.insert({
    ...session(),
    step: 'clarification',
    status: 'waiting_for_user',
    questions: [currentQuestion],
    answers: Array.from({ length: 4 }, (_, index) => storedAnswer(index + 1)),
  });
  seedClarificationRounds(db, 4);
  const prompts = [];
  const finalBrief = { ...brief, goal: 'Use the answer from the final allowed round.' };
  const { service } = createService(store, {
    operate: {
      checkouts: { clone: async () => undefined, cloneDir: () => '/tmp/planner-test' },
      orchestrator: { runOneShot: async (options) => {
        prompts.push(options.prompt);
        return {
          runId: 'run-final-round',
          finalMessage: JSON.stringify({
            summary: 'The final answers are incorporated.',
            brief: finalBrief,
            questions: [question()],
          }),
        };
      } },
    },
  });

  service.answer('idea-1', 0, {
    answers: [{ questionId: currentQuestion.id, optionId: currentQuestion.options[0].id }],
  }, 'alice');
  const ready = await waitFor(() => store.get('idea-1'), (value) => value?.step === 'scope_review');

  assert.equal(ready.answers.length, 5);
  assert.equal(ready.answers[4].value, currentQuestion.options[0].label);
  assert.deepEqual(ready.brief, finalBrief);
  assert.deepEqual(ready.questions, []);
  assert.match(prompts[0], /at most 0 question\(s\)/);
  assert.match(prompts[0], /"questions": \[\] exactly/);
  assert.ok(prompts[0].includes(`${currentQuestion.prompt}: ${currentQuestion.options[0].label}`));
  db.close();
});

test('fifteen submitted clarification answers end questioning even before the round cap', async () => {
  const { db, store } = storeFixture();
  const currentQuestion = storedQuestion();
  store.insert({
    ...session(),
    step: 'clarification',
    status: 'waiting_for_user',
    questions: [currentQuestion],
    answers: Array.from({ length: 14 }, (_, index) => storedAnswer(index + 1)),
  });
  seedClarificationRounds(db, 3);
  const { service } = createService(store, {
    operate: {
      checkouts: { clone: async () => undefined, cloneDir: () => '/tmp/planner-test' },
      orchestrator: { runOneShot: async () => ({
        runId: 'run-answer-cap',
        finalMessage: JSON.stringify({ summary: 'The brief is ready.', brief, questions: [question()] }),
      }) },
    },
  });

  service.answer('idea-1', 0, {
    answers: [{ questionId: currentQuestion.id, value: 'A final custom answer' }],
  }, 'alice');
  const ready = await waitFor(() => store.get('idea-1'), (value) => value?.step === 'scope_review');

  assert.equal(ready.answers.length, 15);
  assert.equal(ready.answers[14].value, 'A final custom answer');
  assert.deepEqual(ready.questions, []);
  db.close();
});

test('a stopped clarification failure cannot fail its replacement run', async () => {
  const { db, store } = storeFixture();
  store.insert(session());
  const runs = [];
  const { service } = createService(store, {
    operate: {
      checkouts: { clone: async () => undefined, cloneDir: () => '/tmp/planner-test' },
      orchestrator: {
        runOneShot: (options) => {
          const pending = deferred();
          const number = runs.length + 1;
          runs.push(pending);
          options.onQueued?.(`queue-${number}`);
          options.onStarted?.(`run-${number}`);
          return pending.promise;
        },
        stopRun: async () => undefined,
      },
    },
  });

  service.startClarification('idea-1', 0, 'alice');
  const first = await waitFor(() => store.get('idea-1'), (value) => value?.activeRunId === 'run-1');
  await service.stop('idea-1', first.revision);
  const stopped = store.get('idea-1');
  service.retry('idea-1', stopped.revision, 'alice');
  await waitFor(() => store.get('idea-1'), (value) => value?.activeRunId === 'run-2');

  runs[0].resolve({ runId: 'run-1', finalMessage: null });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const replacement = store.get('idea-1');
  assert.equal(replacement.status, 'working');
  assert.equal(replacement.activeRunId, 'run-2');

  runs[1].resolve({
    runId: 'run-2',
    finalMessage: JSON.stringify({ summary: 'Replacement result.', brief, questions: [question()] }),
  });
  const completed = await waitFor(() => store.get('idea-1'), (value) => value?.status === 'waiting_for_user');
  assert.equal(completed.questions.length, 1);
  db.close();
});

test('a late successful clarification cannot replace newer questions', async () => {
  const { db, store } = storeFixture();
  store.insert(session());
  const runs = [];
  const { service } = createService(store, {
    operate: {
      checkouts: { clone: async () => undefined, cloneDir: () => '/tmp/planner-test' },
      orchestrator: {
        runOneShot: (options) => {
          const pending = deferred();
          const number = runs.length + 1;
          runs.push(pending);
          options.onQueued?.(`queue-${number}`);
          options.onStarted?.(`run-${number}`);
          return pending.promise;
        },
        stopRun: async () => undefined,
      },
    },
  });

  service.startClarification('idea-1', 0, 'alice');
  const first = await waitFor(() => store.get('idea-1'), (value) => value?.activeRunId === 'run-1');
  await service.stop('idea-1', first.revision);
  service.retry('idea-1', store.get('idea-1').revision, 'alice');
  await waitFor(() => store.get('idea-1'), (value) => value?.activeRunId === 'run-2');

  runs[1].resolve({
    runId: 'run-2',
    finalMessage: JSON.stringify({
      summary: 'Newest result.',
      brief,
      questions: [{ ...question(), prompt: 'Newest question' }],
    }),
  });
  const newest = await waitFor(() => store.get('idea-1'), (value) => value?.questions[0]?.prompt === 'Newest question');
  const newestRevision = newest.revision;

  runs[0].resolve({
    runId: 'run-1',
    finalMessage: JSON.stringify({
      summary: 'Stale result.',
      brief,
      questions: [{ ...question(), prompt: 'Stale question' }],
    }),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const stable = store.get('idea-1');
  assert.equal(stable.questions[0].prompt, 'Newest question');
  assert.equal(stable.revision, newestRevision);
  db.close();
});

test('plan discussion explains questions and turns clear changes into a pending revision', async () => {
  const draft = { title: 'Listing analytics', content: 'A sufficiently detailed planning artifact for listing analytics behavior.' };
  const artifacts = { documentation: draft, specification: draft, implementationPlan: draft };

  {
    const { db, store } = storeFixture();
    store.insert({ ...session(), step: 'analysis_review', status: 'waiting_for_user', analysis, artifacts });
    const { service } = createService(store, {
      operate: {
        checkouts: { clone: async () => undefined, cloneDir: () => '/tmp/planner-test' },
        orchestrator: { runOneShot: async () => ({ finalMessage: JSON.stringify({
          intent: 'explanation',
          answer: 'The architecture list records findings. It does not create ten Board tasks.',
          references: ['architecture'],
          changeInstruction: null,
          clarification: null,
        }) }) },
      },
    });
    service.discuss('idea-1', 0, 'Why are there so many architecture items?', 'architecture', 'alice');
    const answered = await waitFor(() => store.get('idea-1'), (value) => value?.status === 'waiting_for_user' && value.messages.length === 2);
    assert.equal(answered.messages[0].context, 'architecture');
    assert.equal(answered.messages[1].intent, 'explanation');
    assert.equal(answered.pendingRevision, null);
    db.close();
  }

  {
    const { db, store } = storeFixture();
    store.insert({ ...session(), step: 'analysis_review', status: 'waiting_for_user', analysis, artifacts });
    const outputs = [
      JSON.stringify({
        intent: 'change_request',
        answer: 'I will prepare a smaller first release for review.',
        references: ['mvp'],
        changeInstruction: 'Reduce the first release to five essential capabilities.',
        clarification: null,
      }),
      JSON.stringify({ summary: 'Reduced the first release.', brief: { ...brief, mvp: ['Five grouped capabilities'] }, artifacts }),
    ];
    const { service } = createService(store, {
      operate: {
        checkouts: { clone: async () => undefined, cloneDir: () => '/tmp/planner-test' },
        orchestrator: { runOneShot: async () => ({ finalMessage: outputs.shift() ?? null }) },
      },
    });
    service.discuss('idea-1', 0, 'Reduce the MVP to five points.', 'mvp', 'alice');
    const revised = await waitFor(() => store.get('idea-1'), (value) => value?.pendingRevision !== null && value.status === 'waiting_for_user');
    assert.equal(revised.pendingRevision.summary, 'Reduced the first release.');
    assert.equal(revised.messages.filter((message) => message.intent === 'change_request').length, 2);
    assert.equal(outputs.length, 0);
    db.close();
  }
});

test('retry resumes an interrupted discussion instead of treating it as a revision', async () => {
  const { db, store } = storeFixture();
  const draft = { title: 'Listing analytics', content: 'A sufficiently detailed planning artifact for listing analytics behavior.' };
  const artifacts = { documentation: draft, specification: draft, implementationPlan: draft };
  store.insert({
    ...session(),
    step: 'analysis_review',
    status: 'failed',
    analysis,
    artifacts,
    messages: [{
      id: 'pm-1', role: 'user', content: 'Explain the main privacy risk.', createdAt: Date.now(), context: 'risks',
    }],
  });
  const { service } = createService(store, {
    operate: {
      checkouts: { clone: async () => undefined, cloneDir: () => '/tmp/planner-test' },
      orchestrator: { runOneShot: async () => ({ finalMessage: JSON.stringify({
        intent: 'explanation',
        answer: 'The main risk is collecting more user data than the feature needs.',
        references: ['risks'],
        changeInstruction: null,
        clarification: null,
      }) }) },
    },
  });

  service.retry('idea-1', 0, 'alice');
  const answered = await waitFor(() => store.get('idea-1'), (value) => value?.status === 'waiting_for_user');
  assert.equal(answered.pendingRevision, null);
  assert.equal(answered.messages.at(-1).intent, 'explanation');
  assert.equal(answered.messages.at(-1).context, 'risks');
  db.close();
});

test('follow-up changes build on the pending revision and block task preparation until reviewed', async () => {
  const { db, store } = storeFixture();
  const currentDraft = { title: 'Current plan', content: 'The currently accepted implementation plan and its original scope.' };
  const pendingDraft = { title: 'Pending plan', content: 'PENDING REVISION MARKER with a smaller reviewed first release.' };
  const revisedDraft = { title: 'Revised plan', content: 'A combined revision that keeps the smaller release and adds the follow-up change.' };
  const pendingRevision = {
    summary: 'Smaller release proposed.',
    brief: { ...brief, mvp: ['Smaller first release'] },
    artifacts: { documentation: pendingDraft, specification: pendingDraft, implementationPlan: pendingDraft },
  };
  store.insert({
    ...session(),
    step: 'analysis_review',
    status: 'waiting_for_user',
    analysis,
    proposalId: 'prop-1',
    artifacts: { documentation: currentDraft, specification: currentDraft, implementationPlan: currentDraft },
    pendingRevision,
  });
  let revisionPromptText = '';
  const { service } = createService(store, {
    operate: {
      checkouts: { clone: async () => undefined, cloneDir: () => '/tmp/planner-test' },
      orchestrator: { runOneShot: async (options) => {
        revisionPromptText = options.prompt;
        return { finalMessage: JSON.stringify({
          summary: 'Combined both requested changes.',
          brief: { ...brief, mvp: ['Smaller first release'], assumptions: [...brief.assumptions, 'Keep import local'] },
          artifacts: { documentation: revisedDraft, specification: revisedDraft, implementationPlan: revisedDraft },
        }) };
      } },
    },
  });

  assert.throws(() => service.prepareTasks('idea-1', 0, 'alice'), /apply or discard/);
  service.requestRevision('idea-1', 0, 'Also keep the import local to the browser.', 'alice');
  const revised = await waitFor(() => store.get('idea-1'), (value) => value?.pendingRevision?.summary === 'Combined both requested changes.');
  assert.match(revisionPromptText, /PENDING REVISION MARKER/);
  assert.equal(revised.pendingRevision.artifacts.implementationPlan.title, 'Revised plan');
  assert.deepEqual(revised.pendingRevision.brief.mvp, ['Smaller first release']);
  db.close();
});

test('applying a revision keeps the approved MVP canonical in the Ideas analysis and discussion index', async () => {
  const { db, store } = storeFixture();
  const currentDraft = { title: 'Current plan', content: 'The currently accepted implementation plan and its original scope.' };
  const revisedDraft = { title: 'Five-part plan', content: 'The revised implementation plan groups the first release into five capabilities.' };
  const revisedBrief = { ...brief, mvp: ['Import', 'Parse', 'Map', 'Preview', 'Persist'] };
  const verboseAnalysis = { ...analysis, mvp: Array.from({ length: 12 }, (_, index) => `Expanded finding ${index + 1}`) };
  store.insert({
    ...session(),
    step: 'analysis_review',
    status: 'waiting_for_user',
    analysis: verboseAnalysis,
    docId: 'doc-1',
    specId: 'spec-1',
    proposalId: 'prop-1',
    artifacts: { documentation: currentDraft, specification: currentDraft, implementationPlan: currentDraft },
    pendingRevision: {
      summary: 'Group the MVP into five capabilities.',
      brief: revisedBrief,
      artifacts: { documentation: revisedDraft, specification: revisedDraft, implementationPlan: revisedDraft },
    },
  });
  const { service, docs, specs, proposals } = createService(store, { proposalAnalysis: verboseAnalysis });
  docs.set('doc-1', { id: 'doc-1', workspaceId: 'ws-1', title: currentDraft.title, content: currentDraft.content });
  specs.set('spec-1', { id: 'spec-1', workspaceId: 'ws-1', repo: 'owner/repo', title: currentDraft.title, content: currentDraft.content });
  proposals.set('prop-1', { id: 'prop-1', workspaceId: 'ws-1', repo: 'owner/repo', title: currentDraft.title, body: currentDraft.content, analysis: verboseAnalysis });

  service.applyRevision('idea-1', 0, 'alice');
  const applied = await waitFor(() => store.get('idea-1'), (value) => value?.step === 'analysis_review' && value.status === 'waiting_for_user');
  assert.deepEqual(applied.brief.mvp, revisedBrief.mvp);
  assert.deepEqual(applied.analysis.mvp, revisedBrief.mvp);
  assert.equal(applied.analysis.mvp.length, 5);
  const prompt = discussionPrompt({ session: applied, message: 'Where are the five MVP points?', context: 'mvp' });
  assert.match(prompt, /"location":"Release boundary","label":"MVP","count":5/);
  db.close();
});

test('old pending revisions inherit the approved brief when read from storage', () => {
  const { db, store } = storeFixture();
  const draft = { title: 'Legacy revision', content: 'A legacy pending revision created before briefs were synchronized.' };
  store.insert({
    ...session(),
    pendingRevision: { summary: 'Legacy change', artifacts: { documentation: draft, specification: draft, implementationPlan: draft } },
  });
  assert.deepEqual(store.get('idea-1').pendingRevision.brief, brief);
  db.close();
});

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
  const { service, notifications } = createService(store, {
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

  const launched = service.launch('idea-1', 0, 'alice', 'release/next');
  const repeated = service.launch('idea-1', 0, 'alice');
  assert.equal(imports, 1);
  assert.deepEqual(importArgs, ['ref-1', 'alice', true, 'release/next']);
  assert.equal(launched.targetBranch, 'release/next');
  assert.deepEqual(launched.taskIds, ['task-1']);
  assert.equal(repeated.revision, launched.revision);
  assert.equal(repeated.status, 'completed');
  assert.equal(notifications.length, 1);
  assert.deepEqual(notifications[0], {
    kind: 'finished',
    workspaceId: 'ws-1',
    repo: 'owner/repo',
    title: 'Your idea is now on the Board',
    body: 'Analytics: 1 task was created and queued.',
    href: '#/ideas/idea-1',
  });
  db.close();
});

test('launch retry keeps the selected target branch after an import failure', () => {
  const { db, store } = storeFixture();
  store.insert({
    ...session(),
    step: 'tasks_review',
    status: 'waiting_for_user',
    refinementId: 'ref-1',
  });
  const importBranches = [];
  let shouldFail = true;
  const { service } = createService(store, {
    refinement: {
      importAll: (_id, _userId, _queue, targetBranch) => {
        importBranches.push(targetBranch);
        if (shouldFail) {
          shouldFail = false;
          throw new Error('temporary import failure');
        }
      },
      get: () => ({
        refinement: { id: 'ref-1', workspaceId: 'ws-1', repo: 'owner/repo' },
        items: [{ id: 'ri-1', taskId: 'task-1' }],
      }),
    },
  });

  assert.throws(() => service.launch('idea-1', 0, 'alice', 'release/next'), /temporary import failure/);
  const failed = store.get('idea-1');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.targetBranch, 'release/next');

  const launched = service.launch('idea-1', failed.revision, 'alice');
  assert.deepEqual(importBranches, ['release/next', 'release/next']);
  assert.equal(launched.status, 'completed');
  assert.equal(launched.targetBranch, 'release/next');
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
  const { service, notifications } = createService(store, {
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
  assert.deepEqual(notifications, []);
  assert.deepEqual(service.list('ws-1').map((item) => item.id), ['idea-1']);
  assert.equal(service.get('idea-2')?.status, 'cancelled');
  db.close();
});
