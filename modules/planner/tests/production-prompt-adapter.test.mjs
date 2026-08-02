import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPlannerClarificationEvaluationPrompt,
  parseClarification,
  PLANNER_CLARIFICATION_PROMPT_VERSION,
} from '../dist/api/prompts.js';

const brief = {
  problem: 'Maintainers rebuild filters repeatedly.',
  audience: ['maintainers'],
  goal: 'Save private filters.',
  mvp: ['Save', 'Apply', 'Rename', 'Delete', 'Test'],
  outOfScope: [],
  assumptions: [],
  risks: [],
  openDecisions: [],
};
const repositoryContext = {
  summary: 'A TypeScript application.',
  runtimeAndStack: ['TypeScript'],
  architecture: ['modular'],
  dataAndIntegrations: [],
  authorizationAndSecurity: ['RBAC'],
  testingAndDelivery: ['typecheck'],
  relevantPaths: ['modules/code'],
  constraints: [],
};

test('planner evaluation uses the cached production prompt and convergence parser', () => {
  const prompt = buildPlannerClarificationEvaluationPrompt({
    idea: 'Save filters.',
    brief,
    answers: [],
    maxQuestions: 0,
    repositoryContext,
    resolvedDecisionKeys: ['visibility'],
  });
  assert.equal(PLANNER_CLARIFICATION_PROMPT_VERSION, 1);
  assert.match(prompt, /clarification budget is exhausted/i);
  assert.match(prompt, /intentionally an empty scratch space/i);

  const parsed = parseClarification(JSON.stringify({
    summary: 'The brief is ready.',
    readiness: 'ready',
    readinessReason: 'All MVP decisions are explicit.',
    blockingDecisions: [],
    brief,
    questions: [],
  }));
  assert.equal(parsed.readiness, 'ready');
  assert.deepEqual(parsed.questions, []);
});
