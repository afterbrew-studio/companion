import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildContributorFlowDryRun,
  classifyContributorPull,
} from '../dist/api/readiness.js';

const BACKLOG_LINES = [
  70_378, 68_371, 37_589, 36_776, 31_366, 23_878, 11_145, 7_671, 6_978, 6_045,
  5_692, 5_149, 3_629, 3_410, 2_930, 2_901, 2_559, 2_487, 2_040, 2_014,
  1_667, 1_491, 1_435, 1_045, 967, 843, 811, 788, 726, 646, 583, 520, 512,
  438, 423, 334, 286, 277, 222, 220, 217, 196, 193, 190, 186, 167, 163, 97, 21,
];
const BACKLOG_FILES = [
  683, 667, 312, 444, 488, 265, 77, 118, 79, 66, 66, 11, 43, 47, 147, 42, 45,
  40, 51, 43, 27, 37, 38, 21, 37, 28, 31, 22, 32, 20, 20, 14, 14, 14, 15, 8,
  11, 10, 10, 4, 8, 9, 10, 10, 11, 5, 11, 2, 1,
];
const DRAFTS = new Set([0, 6, 11, 13, 15, 17, 20, 22, 38, 42, 43, 44, 48]);
const AGENT_AUTHORED = new Set([
  0, 1, 2, 3, 4, 6, 7, 8, 10, 14, 18, 19, 21, 23, 24, 25, 27, 28, 29, 30,
  31, 32, 33, 34, 35, 37, 39, 47,
]);
const MERGEABLE = new Set([1, 14, 24, 25, 27, 28, 29, 30, 31, 32, 33, 34, 35, 37, 39, 45, 46, 48]);

function pull(index, count = BACKLOG_LINES[index] ?? 100) {
  const number = 600 - index;
  const mergeable = MERGEABLE.has(index);
  return {
    number,
    title: `backlog-shaped pull ${number}`,
    body: '',
    state: 'open',
    merged_at: null,
    closed_at: null,
    draft: DRAFTS.has(index),
    labels: [],
    body: AGENT_AUTHORED.has(index)
      ? '- [x] An agent produced this diff (`agent-authored`)'
      : '',
    assignees: [],
    head: { ref: `pull-${number}`, sha: `sha-${number}` },
    base: { ref: 'main' },
    mergeable,
    mergeable_state: mergeable ? 'clean' : 'dirty',
    user: { login: index < 42 ? 'maintainer' : `contributor-${index}` },
    author_association: index < 42 ? 'OWNER' : 'CONTRIBUTOR',
    additions: Math.floor(count * 0.8),
    deletions: count - Math.floor(count * 0.8),
    changed_files: BACKLOG_FILES[index] ?? 1,
    html_url: `https://github.com/example-org/example-repo/pull/${number}`,
    created_at: '2026-08-02T00:00:00Z',
    updated_at: '2026-08-02T20:00:00Z',
  };
}

function cachedPull(remote, index, now) {
  const ci = index < 33 ? 'failing' : index < 35 ? 'pending' : 'passing';
  return {
    repo: 'example-org/example-repo',
    number: remote.number,
    title: remote.title,
    body: '',
    state: 'open',
    headRef: remote.head.ref,
    headSha: remote.head.sha,
    baseRef: 'main',
    draft: remote.draft,
    author: remote.user.login,
    labels: remote.labels.map((label) => label.name),
    assignees: [],
    comments: 0,
    url: remote.html_url,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    review: null,
    reviewRisk: null,
    reviewDecision: null,
    mergeable: remote.mergeable,
    mergeStateStatus: remote.mergeable_state,
    checks: {
      state: ci,
      total: 10,
      passed: ci === 'passing' ? 10 : 8,
      failed: ci === 'failing' ? 2 : 0,
      pending: ci === 'pending' ? 2 : 0,
      fetchedAt: now,
    },
  };
}

function context(client, cachedPulls) {
  return {
    workspaceId: 'ws-example',
    repo: 'example-org/example-repo',
    defaultBranch: 'main',
    mode: 'governed',
    mergeMethod: 'squash',
    client,
    cachedPulls,
    admission: { repo: 'example-org/example-repo', paused: false, reason: null, pausedBy: null, pausedAt: null },
    missingPermissions: [],
    accounts: { fetch: true, runs: true, pipelines: true, webhooks: true },
    boardEnabled: true,
    webhookConfigured: true,
    webhookHealthy: true,
    publicDeliveryReady: true,
  };
}

test('a backlog-shaped live dry run reports the measured backlog without starting work', async () => {
  const now = Date.now();
  const pulls = BACKLOG_LINES.map((lines, index) => pull(index, lines));
  const byNumber = new Map(pulls.map((item) => [item.number, item]));
  const issues = Array.from({ length: 4 }, (_, index) => ({
    number: 900 + index,
    title: `Issue ${index}`,
    body: '',
    state: 'open',
    labels: index === 1 ? [{ name: 'triage' }] : [],
    user: { login: `reporter-${index}` },
    assignees: [],
    comments: 0,
    html_url: `https://github.com/example-org/example-repo/issues/${900 + index}`,
    created_at: '2026-08-02T00:00:00Z',
    updated_at: '2026-08-02T20:00:00Z',
    closed_at: null,
  }));
  const client = {
    repo: async () => ({
      allow_merge_commit: true,
      allow_squash_merge: true,
      allow_rebase_merge: true,
    }),
    branchProtection: async () => ({
      strict: true,
      enforceAdmins: false,
      requiredContexts: ['lint', 'typecheck'],
      requiredApprovingReviews: 0,
      dismissStaleReviews: false,
      requireCodeOwnerReviews: false,
      requireConversationResolution: false,
      allowForcePushes: true,
    }),
    repositoryAutonomyQueue: async () => ({
      pulls,
      openPullCount: pulls.length,
      pullsComplete: true,
      issues,
      openIssueCount: issues.length,
      issuesComplete: true,
    }),
    pulls: async () => pulls,
    issues: async () => issues,
    pull: async (_repo, number) => byNumber.get(number),
    rateLimitSnapshot: () => ({ limit: 5_000, remaining: 4_723, resetAt: now + 3_600_000, resource: 'core', observedAt: now }),
  };

  const report = await buildContributorFlowDryRun(
    context(client, pulls.map((remote, index) => cachedPull(remote, index, now))),
  );

  assert.equal(report.dryRun, true);
  assert.equal(report.githubMutations, 0);
  assert.equal(report.agentRuns, 0);
  assert.equal(report.status, 'attention', 'repository governance warnings remain visible without inventing a blocker');
  assert.equal(report.source.pullDetailsComplete, true);
  assert.deepEqual(
    {
      openPulls: report.workload.openPulls,
      drafts: report.workload.drafts,
      agentAuthored: report.workload.agentAuthored,
      conflicting: report.workload.conflicting,
      changedLines: report.workload.knownChangedLines,
      median: report.workload.medianChangedLines,
      thousand: report.workload.atLeastOneThousandLines,
      tenThousand: report.workload.atLeastTenThousandLines,
      fiftyFiles: report.workload.atLeastFiftyFiles,
      failing: report.workload.ciFailing,
      pending: report.workload.ciPending,
      passing: report.workload.ciPassing,
      openIssues: report.workload.openIssues,
      unlabelledIssues: report.workload.unlabelledIssues,
    },
    {
      openPulls: 49,
      drafts: 13,
      agentAuthored: 28,
      conflicting: 31,
      changedLines: 348_672,
      median: 967,
      thousand: 24,
      tenThousand: 7,
      fiftyFiles: 13,
      failing: 33,
      pending: 2,
      passing: 14,
      openIssues: 4,
      unlabelledIssues: 3,
    },
  );
  assert.equal(report.checks.find((item) => item.id === 'governance.required-review').status, 'warning');
  assert.equal(report.checks.find((item) => item.id === 'governance.strict-checks').status, 'pass');
  assert.equal(report.checks.find((item) => item.id === 'governance.admin-enforcement').status, 'warning');
  assert.equal(report.checks.find((item) => item.id === 'governance.force-push').status, 'warning');
});

test('agent-authored provenance cannot choose a different lane', () => {
  const now = Date.now();
  const plain = pull(40, 217);
  plain.mergeable = true;
  plain.mergeable_state = 'clean';
  const agent = {
    ...plain,
    labels: [],
    body: '- [x] An agent produced this diff (`agent-authored`)',
  };
  const cached = cachedPull(plain, 40, now);
  cached.checks = { ...cached.checks, state: 'passing', passed: 10, failed: 0 };

  const first = classifyContributorPull({ pull: plain, cached, observedAt: now });
  const second = classifyContributorPull({ pull: agent, cached, observedAt: now });
  assert.equal(first.agentAuthored, false);
  assert.equal(second.agentAuthored, true);
  assert.equal(first.lane, second.lane);
  assert.deepEqual(first.reasons, second.reasons);

  const labelledOnly = { ...plain, labels: [{ name: 'agent-authored' }], body: '' };
  assert.equal(
    classifyContributorPull({ pull: labelledOnly, cached, observedAt: now }).agentAuthored,
    false,
    'a label without body provenance must not count as authored',
  );
});

test('an explicit live no-review decision cannot inherit a stale cached approval', () => {
  const now = Date.now();
  const remote = pull(40, 217);
  remote.mergeable = true;
  remote.mergeable_state = 'clean';
  remote.review_decision = null;
  const cached = cachedPull(remote, 40, now);
  cached.checks = { ...cached.checks, state: 'passing', passed: 10, failed: 0, pending: 0 };
  cached.reviewDecision = 'approved';
  cached.review = 'applied';
  cached.reviewRisk = 'low';

  assert.equal(
    classifyContributorPull({ pull: remote, cached, observedAt: now }).lane,
    'standard-review',
  );
  delete remote.review_decision;
  assert.equal(
    classifyContributorPull({ pull: remote, cached, observedAt: now }).lane,
    'evidence-gate',
    'REST fallback may use a head-matched current cache only when live metadata omitted the field',
  );
});

test('a queue beyond the detail ceiling fails closed instead of extrapolating', async () => {
  const pulls = Array.from({ length: 101 }, (_, index) => pull(index, 100));
  const client = {
    repo: async () => ({ allow_squash_merge: true }),
    branchProtection: async () => null,
    repositoryAutonomyQueue: async () => ({
      pulls: pulls.slice(0, 100),
      openPullCount: pulls.length,
      pullsComplete: false,
      issues: [],
      openIssueCount: 0,
      issuesComplete: true,
    }),
    pulls: async () => pulls,
    issues: async () => [],
    pull: async (_repo, number) => pulls.find((item) => item.number === number),
    rateLimitSnapshot: () => null,
  };
  const report = await buildContributorFlowDryRun(context(client, []));

  assert.equal(report.workload.openPulls, 101);
  assert.equal(report.pulls.length, 100);
  assert.equal(report.source.pullDetailsComplete, false);
  assert.equal(report.status, 'blocked');
});

test('without a fetch account the dry run does not leak cached PR metadata', async () => {
  const remote = pull(0, 100);
  const report = await buildContributorFlowDryRun({
    ...context(null, [cachedPull(remote, 0, Date.now())]),
    accounts: { fetch: false, runs: true, pipelines: true, webhooks: true },
  });
  assert.equal(report.status, 'blocked');
  assert.equal(report.pulls.length, 0);
  assert.equal(report.workload.openPulls, 0);
});
