import assert from 'node:assert/strict';
import test from 'node:test';
import { ModelRouterService } from '../dist/api/model-router-service.js';
import { defaultPolicy } from '../dist/api/default-policy.js';

function serviceWith(policy) {
  const records = [];
  let changes = 0;
  const store = {
    policy: () => policy,
    updatePolicy: () => policy,
    record: (decision) => records.push(decision),
    decisions: () => [],
  };
  const operate = {
    usageForRuns: () => new Map(),
    runners: { servableModels: () => [] },
  };
  return {
    service: new ModelRouterService(store, operate, () => { changes += 1; }),
    records,
    changes: () => changes,
  };
}

test('the default policy is safe until an admin configures and enables it', () => {
  const policy = defaultPolicy(123);
  assert.equal(policy.enabled, false);
  assert.equal(policy.profiles.every((profile) => profile.models.length === 0), true);
  assert.equal(policy.profiles.find((profile) => profile.id === 'reviewer').unavailable, 'fail');
});

test('routing matches exact task and phase and preserves candidate order', () => {
  const base = defaultPolicy();
  const policy = {
    ...base,
    enabled: true,
    profiles: base.profiles.map((profile) =>
      profile.id === 'economy' ? { ...profile, models: ['small', 'backup', 'small'] } : profile,
    ),
  };
  const { service } = serviceWith(policy);
  const request = { task: 'planner.analyses', phase: 'clarify', kind: 'analysis', repo: null, userId: 'alice' };
  assert.deepEqual(service.resolve(request), {
    policyRevision: 1,
    ruleId: 'planner-clarify',
    profileId: 'economy',
    candidateModels: ['small', 'backup'],
    unavailable: 'fallback',
  });
  assert.equal(service.resolve({ ...request, phase: 'revise' }), null);
});

test('recording a decision persists it and emits the module change event', () => {
  const policy = defaultPolicy();
  const state = serviceWith(policy);
  state.service.record({
    runId: 'run-1',
    task: 'code.pr-review',
    kind: 'analysis',
    repo: 'acme/app',
    userId: 'alice',
    phase: 'review',
    policyRevision: 1,
    ruleId: 'code-pr-review',
    profileId: 'reviewer',
    candidateModels: ['strong'],
    unavailable: 'fail',
    selectedModel: 'strong',
    outcome: 'routed',
  });
  assert.equal(state.records.length, 1);
  assert.equal(state.changes(), 1);
});
