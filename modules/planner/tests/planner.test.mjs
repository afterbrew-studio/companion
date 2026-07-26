import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { assertPlannerTransition } from '../dist/api/planner-machine.js';
import {
  clarificationPrompt,
  discussionPrompt,
  emptyFeatureBrief,
  parseArtifactBundle,
  parseClarification,
  parseInitialClarification,
  parsePlannerDiscussion,
  parsePlannerRevision,
  revisionPrompt,
} from '../dist/api/prompts.js';
import { PlannerService } from '../dist/api/planner-service.js';
import { emptyClarificationState, plannerProgress } from '../dist/api/planner-progress.js';
import { PlannerQuestionSetConflict, PlannerRevisionConflict, PlannerStore } from '../dist/api/planner-store.js';

const brief = {
  problem: 'People cannot see listing performance.',
  audience: ['Listing owners'],
  goal: 'Show useful view counts.',
  mvp: ['Count listing views', 'Show totals', 'Respect privacy', 'Reuse existing access rules', 'Test the user flow'],
  outOfScope: ['Paid analytics vendor'],
  assumptions: ['Anonymous aggregation is enough'],
  risks: ['Privacy'],
  openDecisions: [],
};

const repositoryContext = {
  summary: 'A React and TypeScript application backed by Supabase.',
  runtimeAndStack: ['React', 'TypeScript', 'Vite'],
  architecture: ['Feature code is grouped by domain'],
  dataAndIntegrations: ['Supabase stores application data'],
  authorizationAndSecurity: ['Row-level security protects user data'],
  testingAndDelivery: ['Vitest covers application behavior'],
  relevantPaths: ['src/features', 'src/lib/supabase.ts'],
  constraints: ['Reuse the existing UI and data-access patterns'],
};

function initialClarification(fields = {}) {
  const questions = fields.questions ?? [];
  return JSON.stringify({
    summary: 'Repository context is ready.',
    readiness: questions.length > 0 ? 'needs_input' : 'ready',
    readinessReason: questions.length > 0 ? 'A product decision is still blocking the brief.' : 'The brief is complete enough for MVP review.',
    blockingDecisions: questions.map((entry) => entry.decisionKey),
    repositoryContext,
    brief,
    questions,
    ...fields,
  });
}

function clarification(fields = {}) {
  const questions = fields.questions ?? [];
  return JSON.stringify({
    summary: 'The brief was updated.',
    readiness: questions.length > 0 ? 'needs_input' : 'ready',
    readinessReason: questions.length > 0 ? 'A product decision is still blocking the brief.' : 'The brief is complete enough for MVP review.',
    blockingDecisions: questions.map((entry) => entry.decisionKey),
    brief,
    questions,
    ...fields,
  });
}

function question(recommended = 0, decisionKey = 'data_retention') {
  return {
    decisionKey,
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
    decisionKey: raw.decisionKey,
    prompt: raw.prompt,
    whyItMatters: raw.whyItMatters,
    options: raw.options.map((option, index) => ({ id: `po-${index + 1}`, ...option })),
  };
}

function storedAnswer(index) {
  return {
    questionId: `pq-old-${index}`,
    decisionKey: `previous_decision_${index}`,
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
  const parsed = parseClarification(clarification({
    questions: [question(0, 'retention'), question(1, 'billing'), question(2, 'audience')],
  }), (prefix) => `${prefix}-${++id}`);
  assert.equal(parsed.questions.length, 3);
  assert.equal(parsed.questions[0].id, 'pq-1');
  assert.equal(parsed.questions[0].options.length, 3);
  assert.equal(parsed.questions[0].options.filter((option) => option.recommended).length, 1);
  assert.ok(parsed.questions[0].options.every((option) => option.id.startsWith('po-')));
});

test('initial clarification requires one bounded reusable repository snapshot', () => {
  const parsed = parseInitialClarification(initialClarification({ questions: [question()] }));
  assert.deepEqual(parsed.repositoryContext, repositoryContext);
  assert.equal(parsed.questions.length, 1);
  assert.throws(() => parseInitialClarification(JSON.stringify({ summary: 'Missing context.', brief, questions: [] })));
});

test('follow-up clarification uses the cached snapshot and only the latest answer delta', () => {
  const originalIdea = 'A long original idea that should not be repeated';
  const prompt = clarificationPrompt({
    idea: originalIdea,
    brief: { ...brief, problem: originalIdea },
    answers: [{ question: 'Retention?', answer: 'Thirty days' }],
    maxQuestions: 3,
    repositoryContext,
  });
  assert.match(prompt, /repository discovery is already complete/);
  assert.match(prompt, /Thirty days/);
  assert.match(prompt, /Feature code is grouped by domain/);
  assert.doesNotMatch(prompt, new RegExp(originalIdea));
  assert.doesNotMatch(prompt, /Study the repository|Inspect the repository once/);
});

test('initial clarification includes the original idea only once', () => {
  const originalIdea = 'Build enterprise licensing with modular entitlements';
  const prompt = clarificationPrompt({
    idea: originalIdea,
    brief: emptyFeatureBrief(originalIdea),
    answers: [],
    maxQuestions: 3,
    repositoryContext: null,
    resolvedDecisionKeys: [],
  });
  assert.equal(prompt.split(originalIdea).length - 1, 1);
});

test('legacy planning prompts inspect the checkout when no repository snapshot exists', () => {
  const legacyRevision = revisionPrompt('Keep the feature small.', brief, {
    documentation: { title: 'Docs', content: 'Current documentation.' },
    specification: { title: 'Spec', content: 'Current specification.' },
    implementationPlan: { title: 'Plan', content: 'Current implementation plan.' },
  }, null);
  assert.match(legacyRevision, /inspect and search the checked-out repository/);
  assert.doesNotMatch(legacyRevision, /working directory is intentionally an empty scratch space/);

  const legacyDiscussion = discussionPrompt({
    session: { ...session(), analysis, artifacts: null },
    message: 'Explain the plan.',
  });
  assert.match(legacyDiscussion, /inspect and search the checked-out repository/);
  assert.doesNotMatch(legacyDiscussion, /working directory is intentionally an empty scratch space/);
});

test('clarification parser preserves verbose model brief lists for explicit compaction', () => {
  const verboseBrief = {
    ...brief,
    mvp: Array.from({ length: 24 }, (_, index) => `MVP item ${index + 1}`),
    assumptions: Array.from({ length: 22 }, (_, index) => `Assumption ${index + 1}`),
  };
  const parsed = parseClarification(clarification({ brief: verboseBrief }));
  assert.equal(parsed.brief.mvp.length, 24);
  assert.equal(parsed.brief.mvp[23], 'MVP item 24');
  assert.equal(parsed.brief.assumptions.length, 22);
});

test('clarification parser retains a hard safety limit for model brief lists', () => {
  const runawayBrief = { ...brief, mvp: Array.from({ length: 101 }, (_, index) => `MVP item ${index + 1}`) };
  assert.throws(() => parseClarification(clarification({ brief: runawayBrief })));
});

test('clarification parser rejects too many questions, wrong option counts and ambiguous recommendations', () => {
  assert.throws(() => parseClarification(clarification({ questions: [question(), question(), question(), question()] })));
  assert.throws(() => parseClarification(clarification({ questions: [{ ...question(), options: question().options.slice(0, 2) }] })));
  const ambiguous = question();
  ambiguous.options[1].recommended = true;
  assert.throws(() => parseClarification(clarification({ questions: [ambiguous] })));
  assert.throws(() => parseClarification('null'));
  assert.throws(() => parseClarification('not json'));
});

test('clarification readiness must agree with its blocking questions', () => {
  assert.throws(() => parseClarification(clarification({
    readiness: 'ready', readinessReason: 'Ready.', blockingDecisions: [], questions: [question()],
  })));
  assert.throws(() => parseClarification(clarification({
    readiness: 'needs_input', readinessReason: 'Blocked.', blockingDecisions: [], questions: [],
  })));
  assert.throws(() => parseClarification(clarification({
    readiness: 'needs_input', readinessReason: 'Blocked.', blockingDecisions: [], questions: [question()],
  })));
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

test('revision parser accepts each checkpoint shape and rejects incoherent payloads', () => {
  const draft = { title: 'Listing analytics', content: 'A sufficiently detailed markdown artifact describing listing analytics.' };
  const artifacts = { documentation: draft, specification: draft, implementationPlan: draft };
  const legacy = parsePlannerRevision(JSON.stringify({ summary: 'Reduced the MVP.', brief: { ...brief, mvp: ['One', 'Two'] }, artifacts }));
  assert.equal(legacy.kind, 'plan');
  assert.deepEqual(legacy.brief.mvp, ['One', 'Two']);
  assert.equal(parsePlannerRevision(JSON.stringify({
    kind: 'brief', summary: 'Clarified the first release.', brief, artifacts: null, tasks: null,
  })).kind, 'brief');
  assert.equal(parsePlannerRevision(JSON.stringify({
    kind: 'artifacts', summary: 'Aligned the drafts.', brief, artifacts, tasks: null,
  })).kind, 'artifacts');
  const tasks = [{
    id: 'task-a', title: 'Ship analytics', description: 'Implement the reviewed slice.',
    acceptance: '- Analytics are visible', priority: 1, dependsOnIds: [],
  }];
  assert.deepEqual(parsePlannerRevision(JSON.stringify({
    kind: 'tasks', summary: 'Clarified the task.', brief: null, artifacts: null, tasks,
  })).tasks, tasks);
  assert.throws(() => parsePlannerRevision(JSON.stringify({ summary: 'Missing brief.', artifacts })));
  assert.throws(() => parsePlannerRevision(JSON.stringify({
    kind: 'tasks', summary: 'Invalid mixed revision.', brief, artifacts: null, tasks,
  })));
});

test('discussion references are limited to content visible at the current checkpoint', () => {
  const explanation = (references) => JSON.stringify({
    intent: 'explanation', answer: 'Here is the grounded answer.', references,
    changeInstruction: null, clarification: null,
  });
  const scope = { ...session(), step: 'scope_review', status: 'waiting_for_user' };
  assert.equal(parsePlannerDiscussion(explanation(['brief']), scope).references[0].context, 'brief');
  assert.throws(() => parsePlannerDiscussion(explanation(['architecture']), scope), /not visible/);

  const artifacts = { ...session(), step: 'artifacts_review', status: 'waiting_for_user', artifacts: {
    documentation: { title: 'Docs', content: 'A sufficiently detailed documentation draft for the feature.' },
    specification: { title: 'Spec', content: 'A sufficiently detailed specification draft for the feature.' },
    implementationPlan: { title: 'Plan', content: 'A sufficiently detailed implementation plan for the feature.' },
  } };
  assert.equal(parsePlannerDiscussion(explanation(['specification']), artifacts).references[0].context, 'specification');
  assert.throws(() => parsePlannerDiscussion(explanation(['tasks']), artifacts), /not visible/);

  const planReview = { ...session(), step: 'analysis_review', status: 'waiting_for_user', analysis };
  assert.equal(parsePlannerDiscussion(explanation(['architecture']), planReview).references[0].context, 'architecture');
  const taskReview = { ...session(), step: 'tasks_review', status: 'waiting_for_user', refinementId: 'ref-1' };
  assert.equal(parsePlannerDiscussion(explanation(['tasks']), taskReview).references[0].context, 'tasks');
  assert.throws(() => parsePlannerDiscussion(explanation(['mvp']), taskReview), /not visible/);
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
      repository_context_json TEXT, clarification_state_json TEXT,
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
  const sessionWithoutProgress = {
    id: 'idea-1', workspaceId: 'ws-1', repo: 'owner/repo', branch: 'main', targetBranch: 'main', author: 'alice',
    title: 'Analytics', idea: 'Add analytics', step: 'idea', status: 'draft', revision: 0,
    activeAction: null, lastError: null, repositoryContext: null, clarification: emptyClarificationState(), brief, questions: [], answers: [], messages: [], artifacts: null,
    pendingRevision: null, confirmations: { brief: false, artifacts: false, analysis: false, launch: false },
    docId: null, specId: null, proposalId: null, analysis: null, analysisRunId: null,
    refinementId: null, taskIds: [], activeQueueId: null, activeRunId: null, createdAt: now, updatedAt: now,
  };
  return { ...sessionWithoutProgress, progress: plannerProgress(sessionWithoutProgress) };
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
      analyze: async (id, _userId, context) => {
        overrides.onProposalAnalyze?.(context);
        return { ...proposals.get(id), analysis: overrides.proposalAnalysis ?? analysis, analysisRunId: 'run-analysis' };
      },
      acceptPlan: () => undefined,
      list: () => [],
    },
    ...overrides.plan,
  };
  const refinement = {
    importAll: () => undefined,
    get: () => ({ items: [] }),
    ...overrides.refinement,
  };
  const operate = {
    checkouts: { ...(overrides.operate?.checkouts ?? {}) },
    orchestrator: {
      getRun: () => undefined,
      ...(overrides.operate?.orchestrator ?? {}),
    },
  };
  const service = new PlannerService(
    store,
    plan,
    refinement,
    { listBoard: () => ({ config: {}, workers: [] }) },
    { repos: { get: () => undefined, inWorkspace: () => false } },
    operate,
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

test('planner progress contains only real question rounds', () => {
  const initial = session();
  assert.equal(initial.progress.total, 6);
  assert.equal(initial.progress.currentIndex, 0);
  assert.equal(initial.progress.stages[0].label, 'Idea');

  const firstRound = {
    ...initial,
    step: 'clarification',
    status: 'waiting_for_user',
    clarification: {
      ...initial.clarification,
      currentRound: 1,
      roundsCreated: 1,
      questionSetId: 'questions-1',
    },
  };
  const firstProgress = plannerProgress(firstRound);
  assert.equal(firstProgress.total, 7);
  assert.equal(firstProgress.currentIndex, 1);
  assert.equal(firstProgress.stages[1].label, 'Question round 1');

  const secondRound = {
    ...firstRound,
    clarification: {
      ...firstRound.clarification,
      currentRound: 2,
      roundsCreated: 2,
      completedRounds: 1,
      questionSetId: 'questions-2',
    },
  };
  const secondProgress = plannerProgress(secondRound);
  assert.equal(secondProgress.total, 8);
  assert.equal(secondProgress.currentIndex, 2);
  assert.equal(secondProgress.stages[2].label, 'Question round 2');

  const reviewProgress = plannerProgress({
    ...secondRound,
    step: 'scope_review',
    status: 'waiting_for_user',
    clarification: { ...secondRound.clarification, questionSetId: null, completionReason: 'ready' },
  });
  assert.equal(reviewProgress.total, 8);
  assert.equal(reviewProgress.currentIndex, 3);
  assert.equal(reviewProgress.stages[3].label, 'MVP');
});

test('a complete idea reaches MVP after one repository scan and records usage', async () => {
  const { db, store } = storeFixture();
  store.insert(session());
  const runOptions = [];
  const { service } = createService(store, {
    operate: {
      checkouts: { clone: async () => undefined, cloneDir: () => '/tmp/planner-test' },
      orchestrator: {
        runOneShot: async (options) => {
          runOptions.push(options);
          return { runId: 'run-complete-idea', finalMessage: initialClarification() };
        },
        getRun: () => ({ inputTokens: 1_200, outputTokens: 180 }),
      },
    },
  });

  service.startClarification('idea-1', 0, 'alice');
  const ready = await waitFor(() => store.get('idea-1'), (value) => value?.step === 'scope_review');
  const detail = service.detail('idea-1', { id: 'alice' });

  assert.equal(runOptions.length, 1);
  assert.equal(runOptions[0].cwd, '/tmp/planner-test');
  assert.equal(ready.clarification.roundsCreated, 0);
  assert.equal(ready.progress.total, 6);
  assert.equal(ready.progress.stages[ready.progress.currentIndex].label, 'MVP');
  assert.equal(detail.usage.repositoryScanRuns, 1);
  assert.equal(detail.usage.cachedSnapshotRuns, 0);
  assert.equal(detail.usage.totalInputTokens, 1_200);
  assert.equal(detail.usage.totalOutputTokens, 180);
  db.close();
});

test('a stale question set is rejected without saving answers', () => {
  const { db, store } = storeFixture();
  const activeQuestion = storedQuestion();
  store.insert({
    ...session(),
    step: 'clarification',
    status: 'waiting_for_user',
    questions: [activeQuestion],
    clarification: {
      ...emptyClarificationState(),
      currentRound: 1,
      roundsCreated: 1,
      questionSetId: 'questions-current',
    },
  });
  const { service } = createService(store);

  assert.throws(() => service.answer('idea-1', 0, {
    questionSetId: 'questions-stale',
    answers: [{ questionId: activeQuestion.id, optionId: activeQuestion.options[0].id }],
  }, 'alice'), PlannerQuestionSetConflict);
  const unchanged = store.get('idea-1');
  assert.equal(unchanged.revision, 0);
  assert.equal(unchanged.answers.length, 0);
  assert.equal(unchanged.clarification.questionSetId, 'questions-current');
  db.close();
});

test('duplicate decision keys and normalized question text cannot create another round', async () => {
  const { db, store } = storeFixture();
  store.insert(session());
  const repeatedByText = question(1, 'retention_policy_duplicate');
  const outputs = [
    initialClarification({ questions: [question(0, 'data_retention')] }),
    clarification({
      readiness: 'needs_input',
      readinessReason: 'The model attempted to ask the same decision again.',
      blockingDecisions: ['data_retention', 'retention_policy_duplicate'],
      questions: [question(0, 'data_retention'), repeatedByText],
    }),
  ];
  const prompts = [];
  const { service } = createService(store, {
    operate: {
      checkouts: { clone: async () => undefined, cloneDir: () => '/tmp/planner-test' },
      orchestrator: { runOneShot: async (options) => {
        prompts.push(options.prompt);
        return { runId: `run-duplicate-${prompts.length}`, finalMessage: outputs.shift() ?? null };
      } },
    },
  });

  service.startClarification('idea-1', 0, 'alice');
  const waiting = await waitFor(() => store.get('idea-1'), (value) => value?.questions.length === 1);
  const activeQuestion = waiting.questions[0];
  service.answer('idea-1', waiting.revision, {
    questionSetId: waiting.clarification.questionSetId,
    answers: [{ questionId: activeQuestion.id, optionId: activeQuestion.options[0].id }],
  }, 'alice');
  const ready = await waitFor(() => store.get('idea-1'), (value) => value?.step === 'scope_review');

  assert.equal(ready.clarification.roundsCreated, 1);
  assert.equal(ready.clarification.completionReason, 'no_new_decisions');
  assert.deepEqual(ready.clarification.unresolvedDecisions, ['retention_policy_duplicate']);
  assert.ok(ready.brief.openDecisions.includes('Review unresolved decision: Retention policy duplicate'));
  assert.deepEqual(ready.questions, []);
  assert.equal(ready.progress.total, 7);
  assert.doesNotMatch(prompts[1], /Add analytics/);
  db.close();
});

test('an oversized MVP is compacted once without another repository scan', async () => {
  const { db, store } = storeFixture();
  store.insert(session());
  const oversizedBrief = {
    ...brief,
    mvp: Array.from({ length: 12 }, (_, index) => `Detailed capability ${index + 1}`),
  };
  const compactedBrief = {
    ...brief,
    mvp: Array.from({ length: 6 }, (_, index) => `Consolidated capability ${index + 1}`),
  };
  const runOptions = [];
  const outputs = [
    initialClarification({ brief: oversizedBrief }),
    JSON.stringify(compactedBrief),
  ];
  const { service } = createService(store, {
    operate: {
      checkouts: { clone: async () => undefined, cloneDir: () => '/tmp/planner-test' },
      orchestrator: {
        runOneShot: async (options) => {
          runOptions.push(options);
          return { runId: `run-compaction-${runOptions.length}`, finalMessage: outputs.shift() ?? null };
        },
        getRun: (runId) => runId === 'run-compaction-1'
          ? { inputTokens: 2_000, outputTokens: 300 }
          : { inputTokens: 500, outputTokens: 100 },
      },
    },
  });

  service.startClarification('idea-1', 0, 'alice');
  const ready = await waitFor(() => store.get('idea-1'), (value) => value?.step === 'scope_review');
  const usage = service.detail('idea-1', { id: 'alice' }).usage;

  assert.equal(runOptions.length, 2);
  assert.equal(runOptions[0].cwd, '/tmp/planner-test');
  assert.equal(runOptions[1].cwd, undefined);
  assert.deepEqual(ready.brief, compactedBrief);
  assert.ok(ready.brief.mvp.length <= 8);
  assert.match(runOptions[1].prompt, /MVP must contain at most 8 consolidated items/);
  assert.doesNotMatch(runOptions[1].prompt, /Add analytics|Feature code is grouped by domain|repositoryContext/);
  assert.equal(usage.repositoryScanRuns, 1);
  assert.equal(usage.cachedSnapshotRuns, 1);
  assert.ok(usage.runs[1].inputTokens <= usage.runs[0].inputTokens / 2);
  db.close();
});

test('legacy sessions infer stable decision and progress state on read', () => {
  const { db, store } = storeFixture();
  store.insert(session());
  const legacyQuestion = storedQuestion();
  delete legacyQuestion.decisionKey;
  const legacyAnswer = storedAnswer(1);
  delete legacyAnswer.decisionKey;
  db.prepare(`
    UPDATE planner_sessions
    SET step = 'clarification', status = 'waiting_for_user', clarification_state_json = NULL,
      questions_json = ?, answers_json = ?
    WHERE id = 'idea-1'
  `).run(JSON.stringify([legacyQuestion]), JSON.stringify([legacyAnswer]));

  const normalized = store.get('idea-1');
  assert.match(normalized.questions[0].decisionKey, /^how_long_should_data_be_retained/);
  assert.match(normalized.answers[0].decisionKey, /^previous_question_1/);
  assert.equal(normalized.clarification.answerCount, 1);
  assert.equal(normalized.clarification.roundsCreated, 2);
  assert.match(normalized.clarification.questionSetId, /^legacy-/);
  assert.equal(normalized.progress.total, 8);
  db.close();
});

test('clarification persists submitted answers and includes them in the next planning prompt', async () => {
  const { db, store } = storeFixture();
  store.insert(session());
  const prompts = [];
  const runOptions = [];
  const outputs = [
    initialClarification({ summary: 'One decision is needed.', questions: [question()] }),
    clarification({ summary: 'The brief is ready.' }),
  ];
  const { service } = createService(store, {
    operate: {
      checkouts: { clone: async () => undefined, cloneDir: () => '/tmp/planner-test' },
      orchestrator: { runOneShot: async (options) => {
        runOptions.push(options);
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
    questionSetId: waiting.clarification.questionSetId,
    answers: [{ questionId: activeQuestion.id, optionId: selected.id }],
  }, 'alice');
  const ready = await waitFor(() => store.get('idea-1'), (value) => value?.step === 'scope_review');

  assert.equal(ready.answers.length, 1);
  assert.equal(ready.answers[0].question, activeQuestion.prompt);
  assert.equal(ready.answers[0].value, selected.label);
  assert.deepEqual(ready.repositoryContext, repositoryContext);
  assert.equal(runOptions[0].cwd, '/tmp/planner-test');
  assert.equal(runOptions[1].cwd, undefined);
  assert.ok(prompts[1].includes(`${activeQuestion.prompt}: ${selected.label}`));
  assert.doesNotMatch(prompts[1], /Study the repository|Inspect the repository once/);
  assert.doesNotMatch(prompts[1], /Add analytics/);
  assert.ok(prompts[1].length < 40_000);
  db.close();
});

test('planner checkpoints raise actionable inbox notifications with a direct idea link', async () => {
  const { db, store } = storeFixture();
  store.insert(session());
  const outputs = [
    initialClarification({ summary: 'One decision is needed.', questions: [question()] }),
    clarification({ summary: 'The brief is ready.' }),
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
    questionSetId: questionsReady.clarification.questionSetId,
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
    repositoryContext,
    clarification: {
      ...emptyClarificationState(), currentRound: 5, roundsCreated: 5, completedRounds: 4,
      answerCount: 4, questionSetId: 'question-set-5',
    },
    questions: [currentQuestion],
    answers: Array.from({ length: 4 }, (_, index) => storedAnswer(index + 1)),
  });
  const prompts = [];
  const finalBrief = { ...brief, goal: 'Use the answer from the final allowed round.' };
  const { service } = createService(store, {
    operate: {
      checkouts: { clone: async () => undefined, cloneDir: () => '/tmp/planner-test' },
      orchestrator: { runOneShot: async (options) => {
        prompts.push(options.prompt);
        return {
          runId: 'run-final-round',
          finalMessage: clarification({ summary: 'The final answers are incorporated.', brief: finalBrief }),
        };
      } },
    },
  });

  service.answer('idea-1', 0, {
    questionSetId: 'question-set-5',
    answers: [{ questionId: currentQuestion.id, optionId: currentQuestion.options[0].id }],
  }, 'alice');
  const ready = await waitFor(() => store.get('idea-1'), (value) => value?.step === 'scope_review');

  assert.equal(ready.answers.length, 5);
  assert.equal(ready.answers[4].value, currentQuestion.options[0].label);
  assert.deepEqual(ready.brief, finalBrief);
  assert.deepEqual(ready.questions, []);
  assert.match(prompts[0], /at most 0 question\(s\)/);
  assert.match(prompts[0], /"questions": \[\]/);
  assert.ok(prompts[0].includes(`${currentQuestion.prompt}: ${currentQuestion.options[0].label}`));
  assert.doesNotMatch(prompts[0], /Previous answer/);
  db.close();
});

test('fifteen submitted clarification answers end questioning even before the round cap', async () => {
  const { db, store } = storeFixture();
  const currentQuestion = storedQuestion();
  store.insert({
    ...session(),
    step: 'clarification',
    status: 'waiting_for_user',
    repositoryContext,
    clarification: {
      ...emptyClarificationState(), currentRound: 4, roundsCreated: 4, completedRounds: 3,
      answerCount: 14, questionSetId: 'question-set-4',
    },
    questions: [currentQuestion],
    answers: Array.from({ length: 14 }, (_, index) => storedAnswer(index + 1)),
  });
  const { service } = createService(store, {
    operate: {
      checkouts: { clone: async () => undefined, cloneDir: () => '/tmp/planner-test' },
      orchestrator: { runOneShot: async () => ({
        runId: 'run-answer-cap',
        finalMessage: clarification({ summary: 'The brief is ready.' }),
      }) },
    },
  });

  service.answer('idea-1', 0, {
    questionSetId: 'question-set-4',
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
    finalMessage: initialClarification({ summary: 'Replacement result.', questions: [question()] }),
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
    finalMessage: initialClarification({
      summary: 'Newest result.',
      questions: [{ ...question(), prompt: 'Newest question' }],
    }),
  });
  const newest = await waitFor(() => store.get('idea-1'), (value) => value?.questions[0]?.prompt === 'Newest question');
  const newestRevision = newest.revision;

  runs[0].resolve({
    runId: 'run-1',
    finalMessage: initialClarification({
      summary: 'Stale result.',
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

test('checkpoint revisions change canonical data only after explicit apply', () => {
  const draft = { title: 'Current draft', content: 'A sufficiently detailed current planning artifact for this feature.' };
  const revisedDraft = { title: 'Revised draft', content: 'A sufficiently detailed revised planning artifact for this feature.' };

  {
    const { db, store } = storeFixture();
    const revisedBrief = { ...brief, goal: 'A revised product outcome.' };
    store.insert({
      ...session(), step: 'scope_review', status: 'waiting_for_user',
      pendingRevision: { kind: 'brief', summary: 'Revise the outcome.', brief: revisedBrief, artifacts: null, tasks: null },
    });
    const { service } = createService(store);
    assert.equal(store.get('idea-1').brief.goal, brief.goal);
    service.applyRevision('idea-1', 0, 'alice');
    assert.equal(store.get('idea-1').brief.goal, revisedBrief.goal);
    assert.equal(store.get('idea-1').pendingRevision, null);
    db.close();
  }

  {
    const { db, store } = storeFixture();
    const revisedBrief = { ...brief, assumptions: [...brief.assumptions, 'Use the reviewed terminology'] };
    const revisedArtifacts = { documentation: revisedDraft, specification: revisedDraft, implementationPlan: revisedDraft };
    store.insert({
      ...session(), step: 'artifacts_review', status: 'waiting_for_user',
      artifacts: { documentation: draft, specification: draft, implementationPlan: draft },
      pendingRevision: { kind: 'artifacts', summary: 'Align the drafts.', brief: revisedBrief, artifacts: revisedArtifacts, tasks: null },
    });
    const { service } = createService(store);
    service.applyRevision('idea-1', 0, 'alice');
    const applied = store.get('idea-1');
    assert.equal(applied.artifacts.documentation.title, 'Revised draft');
    assert.deepEqual(applied.brief.assumptions, revisedBrief.assumptions);
    db.close();
  }

  {
    const { db, store } = storeFixture();
    const taskRevision = [{
      id: 'task-a', title: 'Clarified task', description: 'The revised task description.',
      acceptance: '- The revised result is verified', priority: 1, dependsOnIds: [],
    }];
    const calls = [];
    store.insert({
      ...session(), step: 'tasks_review', status: 'waiting_for_user', refinementId: 'ref-1',
      pendingRevision: { kind: 'tasks', summary: 'Clarify the task.', brief: null, artifacts: null, tasks: taskRevision },
    });
    const { service } = createService(store, {
      refinement: { replaceProposedItems: (id, tasks) => calls.push({ id, tasks }) },
    });
    assert.throws(() => service.applyRevision('idea-1', 99, 'alice'), PlannerRevisionConflict);
    assert.equal(calls.length, 0);
    service.applyRevision('idea-1', 0, 'alice');
    assert.deepEqual(calls, [{ id: 'ref-1', tasks: taskRevision }]);
    assert.equal(store.get('idea-1').pendingRevision, null);
    db.close();
  }
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

test('Ideas passes its repository snapshot to proposal analysis and records cached usage', async () => {
  const { db, store } = storeFixture();
  const draft = { title: 'Listing analytics', content: 'A detailed artifact for listing analytics and its implementation.' };
  store.insert({
    ...session(),
    repositoryContext,
    step: 'artifacts_review',
    status: 'waiting_for_user',
    artifacts: { documentation: draft, specification: draft, implementationPlan: draft },
  });
  let receivedContext;
  const { service } = createService(store, {
    onProposalAnalyze: (context) => {
      receivedContext = context;
      context.onCompleted?.({
        runId: 'run-analysis',
        contextMode: 'cached_snapshot',
        promptChars: 4_200,
        durationMs: 125,
      });
    },
    operate: {
      orchestrator: {
        getRun: (runId) => runId === 'run-analysis'
          ? { inputTokens: 2_400, outputTokens: 360 }
          : undefined,
      },
    },
  });

  service.createArtifacts('idea-1', 0, 'alice');
  await waitFor(() => store.get('idea-1'), (value) => value?.step === 'analysis_review');
  const usage = service.detail('idea-1', { id: 'alice' }).usage;

  assert.deepEqual(JSON.parse(receivedContext.repositorySnapshot), repositoryContext);
  assert.equal(usage.repositoryScanRuns, 0);
  assert.equal(usage.cachedSnapshotRuns, 1);
  assert.equal(usage.totalInputTokens, 2_400);
  assert.equal(usage.totalOutputTokens, 360);
  assert.equal(usage.runs[0].action, 'Analyze implementation plan');
  db.close();
});

test('Ideas passes the same repository snapshot to refinement and records cached usage', async () => {
  const { db, store } = storeFixture();
  const draft = { title: 'Listing analytics', content: 'A detailed artifact for listing analytics and its implementation.' };
  store.insert({
    ...session(),
    repositoryContext,
    step: 'analysis_review',
    status: 'waiting_for_user',
    artifacts: { documentation: draft, specification: draft, implementationPlan: draft },
    docId: 'doc-1',
    specId: 'spec-1',
    proposalId: 'prop-1',
    analysis,
  });
  let decompositionComplete = false;
  let receivedContext;
  const proposedItem = { id: 'ri-1', status: 'proposed' };
  const { service } = createService(store, {
    refinement: {
      create: () => ({ id: 'ref-1' }),
      get: () => decompositionComplete
        ? { refinement: { id: 'ref-1', status: 'ready', error: null }, items: [proposedItem] }
        : { refinement: { id: 'ref-1', status: 'draft', error: null }, items: [] },
      startDecompose: () => ({
        id: 'method-1',
        prompt: 'Decompose the implementation plan.',
        source: 'builtin',
      }),
      runDecompose: async (_id, _method, _userId, context) => {
        receivedContext = context;
        context.onCompleted?.({
          runId: 'run-refinement',
          contextMode: 'cached_snapshot',
          promptChars: 5_100,
          durationMs: 160,
        });
        decompositionComplete = true;
      },
    },
    operate: {
      orchestrator: {
        getRun: (runId) => runId === 'run-refinement'
          ? { inputTokens: 2_800, outputTokens: 420 }
          : undefined,
      },
    },
  });

  service.prepareTasks('idea-1', 0, 'alice');
  await waitFor(() => store.get('idea-1'), (value) => value?.step === 'tasks_review');
  const usage = service.detail('idea-1', { id: 'alice' }).usage;

  assert.deepEqual(JSON.parse(receivedContext.repositorySnapshot), repositoryContext);
  assert.equal(usage.repositoryScanRuns, 0);
  assert.equal(usage.cachedSnapshotRuns, 1);
  assert.equal(usage.totalInputTokens, 2_800);
  assert.equal(usage.totalOutputTokens, 420);
  assert.equal(usage.runs[0].action, 'Prepare implementation tasks');
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
