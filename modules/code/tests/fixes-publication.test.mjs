import assert from 'node:assert/strict';
import test from 'node:test';
import { Fixes } from '../dist/api/fixes.js';

test('fresh approval publishes one clean, templated, repo-shaped draft PR', async () => {
  const calls = [];
  const run = {
    id: 'fix-568',
    repo: 'example-org/example-repo',
    branch: 'test/harden-probes-abcd',
    cwd: '/tmp/fix-568',
    runner_id: null,
    user_id: 'alice',
    title: 'Fix #568: test: harden full-suite probes',
    outcome: `PR title: test: harden full-suite integration probes

Hardened the integration probes and ran targeted tests.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`,
    issue_number: 568,
    pr_url: null,
    model: 'MiniMax-M3',
  };
  const backend = {
    commitAll: async (...args) => calls.push(['commit', ...args]),
    push: async (...args) => calls.push(['push', ...args]),
    diffVsBase: async () => '',
  };
  const labelled = [];
  const created = [];
  const client = {
    viewer: async () => ({ login: 'alice' }),
    createPr: async (_repo, args) => {
      created.push(args);
      return { html_url: 'https://github.com/example-org/example-repo/pull/999', number: 999 };
    },
    issue: async () => ({
      labels: [{ name: 'tier:ai' }, { name: 'agent:ready' }, { name: 'complexity:tiny' }],
      body: 'Relevant files: agents/rules/foo.md',
    }),
    repo: async () => ({ default_branch: 'main' }),
    repoTextFiles: async () => new Map([['.github/labels.json', JSON.stringify({
      labels: [
        { name: 'tier:ai', scope: 'both', status: 'active' },
        { name: 'complexity:tiny', scope: 'both', status: 'active' },
        { name: 'agent:ready', scope: 'issue', status: 'active' },
        { name: 'model:MiniMax-M3', scope: 'pr', status: 'retiring' },
      ],
    })]]),
    addLabels: async (_repo, number, labels) => labelled.push({ number, labels }),
  };
  const store = {
    runs: {
      get: () => run,
      setPr: (...args) => calls.push(['set-pr', ...args]),
      updateStatus: (...args) => calls.push(['status', ...args]),
    },
    repos: { get: () => ({ default_branch: 'main' }) },
  };
  const orchestrator = {
    runners: { backend: () => backend },
    markRun: (...args) => calls.push(['mark', ...args]),
    stopRun: async (...args) => calls.push(['stop', ...args]),
  };
  const template = `## Summary
<!-- What changed, and why. -->

## Validation
- [ ] pnpm test

## Provenance
- [ ] An agent produced this diff (\`agent-authored\`)`;
  const context = {
    repo: run.repo,
    ref: 'main',
    scannedAt: Date.now(),
    truncated: false,
    files: [{
      path: '.github/pull_request_template.md',
      kind: 'pull-request-template',
      name: 'pull_request_template.md',
      description: null,
      content: template,
      size: template.length,
      truncated: false,
      primary: true,
    }],
    policies: {
      noAiAttribution: true,
      pullRequestDraft: true,
      conventionalPrTitle: true,
      agentProvenance: true,
      branchPrefixes: ['test'],
    },
  };
  const fixes = new Fixes(
    store,
    orchestrator,
    () => client,
    async () => true,
    async () => ({ client, tried: [] }),
    () => true,
    {},
    { scan: async () => context },
    () => undefined,
  );

  const result = await fixes.approve(run.id, {}, 'alice');

  assert.equal(result.prUrl, 'https://github.com/example-org/example-repo/pull/999');
  assert.deepEqual(calls[0], [
    'commit',
    run.cwd,
    'test: harden full-suite integration probes',
    { name: 'alice', email: 'alice@users.noreply.github.com' },
    'main',
  ]);
  assert.deepEqual(created[0], {
    title: 'test: harden full-suite integration probes',
    head: run.branch,
    base: 'main',
    draft: true,
    body: `## Summary
<!-- What changed, and why. -->

Hardened the integration probes and ran targeted tests.

Closes #568.

Worker model: \`MiniMax-M3\`.

## Validation
- [ ] pnpm test

## Provenance
- [x] An agent produced this diff (\`agent-authored\`)`,
  });
  assert.doesNotMatch(created[0].body, /Co-Authored-By/i);
  assert.doesNotMatch(created[0].body, /model:MiniMax-M3/);
  assert.deepEqual(labelled, [{ number: 999, labels: ['tier:ai', 'complexity:tiny'] }]);
});

test('approve refuses an unnamed .github edit before committing', async () => {
  const calls = [];
  const run = {
    id: 'fix-ci-1',
    repo: 'example-org/example-repo',
    branch: 'fix/ci',
    cwd: '/tmp/fix-ci-1',
    runner_id: null,
    user_id: 'alice',
    title: 'Fix CI',
    outcome: 'tweaked a workflow',
    issue_number: 25,
    pr_url: 'https://github.com/example-org/example-repo/pull/8',
    model: 'MiniMax-M3',
  };
  const backend = {
    commitAll: async (...args) => calls.push(['commit', ...args]),
    push: async (...args) => calls.push(['push', ...args]),
    diffVsBase: async () =>
      'diff --git a/.github/workflows/review-dispatch.yml b/.github/workflows/review-dispatch.yml\n',
  };
  const client = {
    viewer: async () => ({ login: 'alice' }),
    issue: async () => ({
      labels: [],
      body: 'Relevant files:\n- agents/rules/model-routing.md',
    }),
  };
  const store = {
    runs: { get: () => run, setPr: () => undefined, updateStatus: () => undefined },
    repos: { get: () => ({ default_branch: 'main' }) },
  };
  const fixes = new Fixes(
    store,
    {
      runners: { backend: () => backend },
      markRun: () => undefined,
      stopRun: async () => undefined,
    },
    () => client,
    async () => true,
    async () => ({ client, tried: [] }),
    () => true,
    {},
    { scan: async () => ({ policies: { conventionalPrTitle: false, pullRequestDraft: false, noAiAttribution: false, agentProvenance: false, branchPrefixes: [] }, files: [] }) },
    () => undefined,
  );

  await assert.rejects(() => fixes.approve(run.id, {}, 'alice'), (err) => {
    assert.equal(err.name, 'ForbiddenGithubEdit');
    return true;
  });
  assert.equal(calls.length, 0, 'the forbidden diff must not be committed');
});

/**
 * A repair pushes to a branch that already has commits, so its own commit has
 * to be a descendant of that branch rather than of the base. An agent that
 * reached for `git reset` left HEAD a sibling, and the push was rejected
 * non-fast-forward after the whole turn had been spent - the card burned its
 * last attempt on a failure that had nothing to do with its change.
 */
test('a repair on an existing pull request commits onto that branch, not the base', async () => {
  const calls = [];
  const run = {
    id: 'fix-570',
    repo: 'example-org/example-repo',
    branch: 'companion/task-abc-defg',
    cwd: '/tmp/fix-570',
    runner_id: null,
    user_id: 'alice',
    title: 'Fix CI on PR #564',
    outcome: 'Repaired the failing gate.',
    issue_number: 509,
    pr_url: 'https://github.com/example-org/example-repo/pull/564',
    model: 'MiniMax-M3',
  };
  const backend = {
    commitAll: async (...args) => calls.push(['commit', ...args]),
    push: async (...args) => calls.push(['push', ...args]),
    diffVsBase: async () => '',
  };
  const client = {
    viewer: async () => ({ login: 'alice' }),
    createPr: async () => {
      throw new Error('a repair must not open a second pull request');
    },
    issue: async () => ({ labels: [], body: '' }),
    repo: async () => ({ default_branch: 'main' }),
    repoTextFiles: async () => new Map(),
    addLabels: async () => undefined,
  };
  const store = {
    runs: {
      get: () => run,
      setPr: (...args) => calls.push(['set-pr', ...args]),
      updateStatus: (...args) => calls.push(['status', ...args]),
    },
    repos: { get: () => ({ default_branch: 'main' }) },
  };
  const orchestrator = {
    runners: { backend: () => backend },
    markRun: (...args) => calls.push(['mark', ...args]),
    stopRun: async (...args) => calls.push(['stop', ...args]),
  };
  const context = {
    repo: run.repo,
    ref: 'main',
    scannedAt: Date.now(),
    truncated: false,
    files: [],
    policies: {
      noAiAttribution: true,
      pullRequestDraft: false,
      conventionalPrTitle: false,
      agentProvenance: false,
      branchPrefixes: [],
    },
  };
  const fixes = new Fixes(
    store,
    orchestrator,
    () => client,
    async () => true,
    async () => ({ client, tried: [] }),
    () => true,
    {},
    { scan: async () => context },
    () => undefined,
  );

  await fixes.approve(run.id, {}, 'alice');

  const commit = calls.find((c) => c[0] === 'commit');
  assert.ok(commit, 'it commits');
  assert.equal(commit[4], run.branch, 'resets onto the pull request branch, not the base');
  assert.notEqual(commit[4], 'main');
  assert.deepEqual(
    calls.find((c) => c[0] === 'push')?.slice(1, 4),
    [run.repo, run.cwd, run.branch],
  );
});
