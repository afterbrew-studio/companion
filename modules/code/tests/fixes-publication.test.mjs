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
  };
  const backend = {
    commitAll: async (...args) => calls.push(['commit', ...args]),
    push: async (...args) => calls.push(['push', ...args]),
  };
  const created = [];
  const client = {
    viewer: async () => ({ login: 'alice' }),
    createPr: async (_repo, args) => {
      created.push(args);
      return { html_url: 'https://github.com/example-org/example-repo/pull/999', number: 999 };
    },
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

## Validation
- [ ] pnpm test

## Provenance
- [x] An agent produced this diff (\`agent-authored\`)`,
  });
  assert.doesNotMatch(created[0].body, /Co-Authored-By/i);
});
