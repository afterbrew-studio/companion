import assert from 'node:assert/strict';
import test from 'node:test';
import { Fixes } from '../dist/api/fixes.js';

const MAP = 'scripts/lint/doc_ownership.json';
const RULES = JSON.stringify({ rules: [{ when: ['scripts/lint/*.py'], update: ['agents/rules/AGENT-INDEX.md'] }] });

/** The real shape: a first commit that trips the ownership gate, then a repair. */
const COMMITS = [
  { sha: 'd7d7f4469aaa', commit: { message: 'fix: hand-rolled ls-files\n' } },
  { sha: '74f30d051bbb', commit: { message: 'fix: repair once\n' } },
];

function harness({ mapText = RULES, commits = COMMITS, filesBySha = {}, push, mergeBase = true } = {}) {
  const calls = [];
  const client = {
    viewer: async () => ({ login: 'alice' }),
    pull: async () => ({ base: { ref: 'main' }, head: { ref: 'companion/task-abc' }, title: 't', body: '' }),
    repoTextFiles: async () => new Map(mapText === null ? [] : [[MAP, mapText]]),
    prCommits: async () => ({ commits, truncated: false }),
    commitFiles: async (_repo, sha) => filesBySha[sha] ?? [],
    createPr: async () => ({ html_url: 'https://example.test/pull/2', number: 2 }),
    updatePr: async () => undefined,
    closePr: async () => undefined,
    comment: async () => undefined,
  };
  const backend = {
    fetchOrigin: async () => undefined,
    addWorktreeAtBranch: async () => '/tmp/reopen',
    resetOntoMergeBase: async (...args) => {
      calls.push(['merge-base', ...args]);
      return mergeBase;
    },
    commitAll: async (...args) => calls.push(['commit', ...args]),
    push: push ?? (async (...args) => calls.push(['push', ...args])),
    removeWorktree: async () => undefined,
  };
  const fixes = new Fixes(
    { runs: { get: () => null }, repos: { get: () => ({ default_branch: 'main' }) } },
    { runners: { backend: () => backend } },
    () => client,
    async () => true,
    async () => ({ client, tried: [] }),
    () => true,
    {},
    { scan: async () => ({ files: [], policies: {} }) },
    () => undefined,
  );
  return { fixes, calls };
}

test('an unrecoverable ancestor opens a successor', async () => {
  const { fixes } = harness({
    filesBySha: {
      d7d7f4469aaa: ['scripts/lint/check_references.py'],
      '74f30d051bbb': ['scripts/lint/check_references.py', 'agents/rules/AGENT-INDEX.md'],
    },
  });
  const result = await fixes.reopenCleanHistory('owner/repo', 564, 'alice', 'CI is red');
  assert.equal(result?.prNumber, 2);
});

/**
 * The silent-blindness case. GitHub returns `files` only up to a limit and the
 * client maps a missing list to `[]`; an empty list matches no `when` glob, so
 * every commit reads as innocent and the pull request stays unrepairable with
 * nothing said. An empty result is a failed read, not a clean commit.
 */
test('a commit whose file list could not be read is not judged clean', async () => {
  const { fixes } = harness({ filesBySha: {} });
  const result = await fixes.reopenCleanHistory('owner/repo', 564, 'alice', 'CI is red');
  assert.equal(result, null, 'it declines rather than concluding the history is fine');
});

test('a genuinely clean history declines too, and for a different reason', async () => {
  // The guard: declining must not become the answer to everything.
  const { fixes } = harness({
    filesBySha: {
      d7d7f4469aaa: ['docs/product.md'],
      '74f30d051bbb': ['docs/product.md'],
    },
  });
  assert.equal(await fixes.reopenCleanHistory('owner/repo', 564, 'alice', 'CI is red'), null);
});

test('a single-commit pull request has no ancestor to be stuck on', async () => {
  const { fixes } = harness({
    commits: [COMMITS[0]],
    filesBySha: { d7d7f4469aaa: ['scripts/lint/check_references.py'] },
  });
  assert.equal(await fixes.reopenCleanHistory('owner/repo', 564, 'alice', 'CI is red'), null);
});

test('an absent ownership map declines rather than guessing', async () => {
  const { fixes } = harness({ mapText: null });
  assert.equal(await fixes.reopenCleanHistory('owner/repo', 564, 'alice', 'CI is red'), null);
});

test('the successor is squashed onto the branch point, not onto the base tip', async () => {
  // Onto the tip, the commit's tree is the old pull request's snapshot, so
  // every change the base landed since reads as a deletion. rayf #602 was built
  // that way and proposed removing four files its task never touched.
  const { fixes, calls } = harness({
    filesBySha: {
      d7d7f4469aaa: ['scripts/lint/check_references.py'],
      '74f30d051bbb': ['scripts/lint/check_references.py', 'agents/rules/AGENT-INDEX.md'],
    },
  });
  await fixes.reopenCleanHistory('owner/repo', 564, 'alice', 'CI is red');

  assert.deepEqual(
    calls.find((c) => c[0] === 'merge-base'),
    ['merge-base', '/tmp/reopen', 'main'],
  );
  const commit = calls.find((c) => c[0] === 'commit');
  // A fourth argument here is a reset onto the moving base, which is the defect.
  assert.equal(commit.length, 4, `commitAll must not reset onto a branch: ${JSON.stringify(commit)}`);
});

test('an unresolvable branch point declines instead of building a reverting successor', async () => {
  const { fixes, calls } = harness({
    mergeBase: false,
    filesBySha: {
      d7d7f4469aaa: ['scripts/lint/check_references.py'],
      '74f30d051bbb': ['scripts/lint/check_references.py', 'agents/rules/AGENT-INDEX.md'],
    },
  });
  assert.equal(await fixes.reopenCleanHistory('owner/repo', 564, 'alice', 'CI is red'), null);
  assert.equal(calls.some((c) => c[0] === 'commit'), false);
  assert.equal(calls.some((c) => c[0] === 'push'), false);
});
