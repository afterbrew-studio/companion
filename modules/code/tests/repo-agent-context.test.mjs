import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubError } from '../dist/api/github-client.js';
import {
  mergePullRequestBody,
  pullRequestSummary,
  pullRequestTitle,
  RepoAgentContextScanner,
  repositoryBranchPrefix,
  repositoryGuidancePrompt,
} from '../dist/api/repo-agent-context.js';

const files = new Map([
  ['agents', `# Repository rules

- PR titles use conventional commit syntax.
- Branch names: \`fix/<short-topic>\`, \`test/<short-topic>\`.
- Load the relevant repository skill before work.
`],
  ['skill', `---
name: create-a-pr
description: Create a repository-compliant pull request.
---

Open every PR as a draft. Use \`gh pr create --draft\`.
`],
  ['generated-skill', `---
name: create-a-pr
description: Generated tool mirror.
---

Open every PR as a draft.
`],
  ['skill-link', '../../../.rulesync/skills/create-a-pr/SKILL.md'],
  ['template', `## Summary
<!-- What changed, and why. -->

## Validation
- [ ] pnpm typecheck

## Provenance
- [ ] An agent produced this diff (\`agent-authored\`)
`],
]);

test('one trusted scan discovers rules, skills, template and enforceable policies', async () => {
  const scanner = new RepoAgentContextScanner();
  const client = {
    repoTree: async () => ({
      truncated: false,
      tree: [
        { path: 'AGENTS.md', type: 'blob', mode: '100644', sha: 'agents', size: files.get('agents').length },
        { path: '.claude/skills/create-a-pr/SKILL.md', type: 'blob', mode: '120000', sha: 'skill-link', size: files.get('skill-link').length },
        { path: '.github/skills/create-a-pr/SKILL.md', type: 'blob', mode: '100644', sha: 'generated-skill', size: files.get('generated-skill').length },
        { path: '.rulesync/skills/create-a-pr/SKILL.md', type: 'blob', mode: '100644', sha: 'skill', size: files.get('skill').length },
        { path: '.github/pull_request_template.md', type: 'blob', mode: '100644', sha: 'template', size: files.get('template').length },
      ],
    }),
    repoTextFiles: async (_repo, _ref, paths) => new Map(paths.map((path) => [
      path,
      path === 'AGENTS.md'
        ? files.get('agents')
        : path.includes('pull_request_template')
          ? files.get('template')
          : files.get('skill'),
    ])),
    repoTextBlob: async (_repo, sha) => files.get(sha),
  };

  const context = await scanner.scan(client, 'octanejs/octane', 'main');

  assert.deepEqual(context.files.map((file) => [file.kind, file.path, file.primary]), [
    ['instructions', 'AGENTS.md', false],
    ['skill', '.rulesync/skills/create-a-pr/SKILL.md', false],
    ['pull-request-template', '.github/pull_request_template.md', true],
  ]);
  assert.equal(context.files[1].name, 'create-a-pr');
  assert.equal(context.policies.pullRequestDraft, true);
  assert.equal(context.policies.conventionalPrTitle, true);
  assert.equal(context.policies.agentProvenance, true);
  assert.deepEqual(context.policies.branchPrefixes, ['fix', 'test']);
});

test('PR publication removes generic attribution while preserving repo-required provenance', () => {
  const template = files.get('template');
  const body = mergePullRequestBody(
    template,
    `Fixed the flaky probes.

- Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
- Generated with [Claude Code](https://claude.example)`,
  );

  assert.match(body, /## Summary[\s\S]*Fixed the flaky probes\./);
  assert.doesNotMatch(body, /Co-Authored-By/i);
  assert.doesNotMatch(body, /Generated with/i);
  assert.match(body, /- \[x\] An agent produced this diff/);
  assert.match(body, /- \[ \] pnpm typecheck/);
});

test('legacy issue titles and agent summaries become clean repository-shaped metadata', () => {
  const outcome = `PR title: test: harden full-suite probes

Adjusted the integration probes and ran the targeted suite.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`;

  assert.equal(
    pullRequestTitle('Fix #568: flaky integration probes', outcome, undefined, true),
    'test: harden full-suite probes',
  );
  assert.equal(
    pullRequestTitle('Fix #568: test: harden full-suite probes', outcome, 'Fix #568: test: harden full-suite probes', true),
    'test: harden full-suite probes',
  );
  assert.equal(pullRequestSummary(outcome), 'Adjusted the integration probes and ran the targeted suite.');
});

test('guidance keeps platform boundaries explicit and offers trusted skills', async () => {
  const scanner = new RepoAgentContextScanner();
  const client = {
    repoTree: async () => ({
      truncated: false,
      tree: [
        { path: 'AGENTS.md', type: 'blob', mode: '100644', sha: 'agents', size: files.get('agents').length },
        { path: '.rulesync/skills/create-a-pr/SKILL.md', type: 'blob', mode: '100644', sha: 'skill', size: files.get('skill').length },
      ],
    }),
    repoTextFiles: async (_repo, _ref, paths) => new Map(paths.map((path) => [
      path,
      path === 'AGENTS.md' ? files.get('agents') : files.get('skill'),
    ])),
    repoTextBlob: async (_repo, sha) => files.get(sha),
  };
  const context = await scanner.scan(client, 'octanejs/octane', 'main');
  const prompt = repositoryGuidancePrompt(context);

  assert.match(prompt, /Leave all changes uncommitted/);
  assert.match(prompt, /Never add Co-Authored-By/);
  assert.match(prompt, /create-a-pr/);
  assert.match(prompt, /origin\/main:<skill-path>/);
  assert.equal(repositoryBranchPrefix('companion/issue-568', 'Fix #568: test: harden probes', 'fix', context), 'test/harden-probes');
});

test('a GraphQL rate failure does not fan out into one REST request per file', async () => {
  let blobReads = 0;
  const scanner = new RepoAgentContextScanner();
  const client = {
    repoTree: async () => ({
      truncated: false,
      tree: [
        { path: 'AGENTS.md', type: 'blob', mode: '100644', sha: 'agents', size: files.get('agents').length },
        { path: '.github/pull_request_template.md', type: 'blob', mode: '100644', sha: 'template', size: files.get('template').length },
      ],
    }),
    repoTextFiles: async () => {
      throw new GitHubError('API rate limit exceeded', 403, true);
    },
    repoTextBlob: async () => {
      blobReads += 1;
      return '';
    },
  };

  await assert.rejects(scanner.scan(client, 'acme/app', 'main'), /rate limit/i);
  assert.equal(blobReads, 0);
});

test('same-content nested AGENTS files keep their distinct directory scopes', async () => {
  const scanner = new RepoAgentContextScanner();
  const client = {
    repoTree: async () => ({
      truncated: false,
      tree: [
        { path: 'packages/a/AGENTS.md', type: 'blob', mode: '100644', sha: 'shared', size: 12 },
        { path: 'packages/b/AGENTS.md', type: 'blob', mode: '100644', sha: 'shared', size: 12 },
      ],
    }),
    repoTextFiles: async (_repo, _ref, paths) => new Map(paths.map((path) => [path, '# Same rules'])),
  };

  const context = await scanner.scan(client, 'acme/app', 'main');

  assert.deepEqual(context.files.map((file) => file.path), [
    'packages/a/AGENTS.md',
    'packages/b/AGENTS.md',
  ]);
  const prompt = repositoryGuidancePrompt(context);
  assert.match(prompt, /### packages\/a\/AGENTS\.md/);
  assert.match(prompt, /### packages\/b\/AGENTS\.md/);
});
