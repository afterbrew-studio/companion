import assert from 'node:assert/strict';
import test from 'node:test';
import { Docs } from '../dist/api/docs.js';

/**
 * Docs.generate must run its agent inside a disposable base worktree like spec
 * generation and proposal analysis, never inside the shared clone directory.
 */
test('doc generation for a repo runs inside a disposable base worktree', async () => {
  const worktrees = [];
  const agentCwds = [];
  const checkouts = {
    hasClone: () => true,
    cloneDir: (repo) => `/clones/${repo}`,
    withBaseWorktree: async (repo, key, branch, fn) => {
      worktrees.push({ repo, key, branch });
      return fn(`/worktrees/${key}`);
    },
  };
  const orchestrator = {
    runOneShot: async (opts) => {
      agentCwds.push(opts.cwd);
      return {
        runId: 'run-1',
        finalMessage: JSON.stringify({ title: 'Cache design', content: 'c'.repeat(60) }),
      };
    },
  };
  const inserted = [];
  const store = {
    repos: { get: () => ({ default_branch: 'main' }) },
    settings: { get: () => null },
    docs: {
      insert: (doc) => inserted.push(doc),
      setChunks: () => {},
      get: (id) => inserted.find((doc) => doc.id === id),
      listWorkspace: () => [],
    },
  };
  const docs = new Docs(store, orchestrator, checkouts, () => {});

  const doc = await docs.generate('ws-1', { repo: 'acme/app', instructions: 'document the cache' }, 'alice');

  assert.equal(worktrees.length, 1);
  assert.equal(worktrees[0].repo, 'acme/app');
  assert.equal(worktrees[0].branch, 'main');
  assert.deepEqual(agentCwds, [`/worktrees/${worktrees[0].key}`], 'the agent never sees the shared clone');
  assert.equal(doc.title, 'Cache design');
});
