import assert from 'node:assert/strict';
import test from 'node:test';
import { Fixes } from '../dist/api/fixes.js';

function fixture(
  decisions,
  scan = async (_client, repo, ref) => ({
    repo,
    ref,
    scannedAt: Date.now(),
    files: [],
    truncated: false,
    policies: {
      noAiAttribution: true,
      pullRequestDraft: false,
      conventionalPrTitle: false,
      agentProvenance: false,
      branchPrefixes: [],
    },
  }),
) {
  const calls = [];
  const run = { id: 'repair-1', status: 'running' };
  const backend = {
    ensureClone: async () => calls.push('clone'),
    fetchOrigin: async () => calls.push('fetch'),
    addWorktreeAtBranch: async () => {
      calls.push('worktree');
      return '/tmp/repair-1';
    },
    addWorktree: async () => {
      calls.push('goal-worktree');
      return '/tmp/goal-1';
    },
  };
  const orchestrator = {
    runners: { backend: () => backend },
    placeRun: () => null,
    prepareRunPlacement: () => ({ runnerId: null, routingResolution: null }),
    createRun: async () => {
      calls.push('create');
      return run;
    },
    getRun: () => run,
    stopRun: async () => calls.push('stop'),
    setGoalMode: async () => calls.push('goal'),
    sendPrompt: async () => calls.push('prompt'),
  };
  const store = {
    prs: {
      get: () => ({
        repo: 'acme/app',
        number: 7,
        title: 'Change',
        state: 'open',
        headRef: 'feature',
        baseRef: 'main',
        url: 'https://github.com/acme/app/pull/7',
      }),
      setMergeable: () => undefined,
    },
    runs: { setPr: () => calls.push('link') },
  };
  const fixes = new Fixes(
    store,
    orchestrator,
    () => ({ pull: async () => ({ mergeable: undefined }) }),
    async () => true,
    async () => ({ client: null, tried: [] }),
    () => true,
    {},
    { scan },
    () => undefined,
  );
  let check = 0;
  const options = {
    onCreated: (id) => calls.push(`owner:${id}`),
    shouldStart: () => decisions[Math.min(check++, decisions.length - 1)],
  };
  return { fixes, calls, options };
}

test('a repair cancelled during preparation is exposed and stopped before goal mode', async () => {
  const { fixes, calls, options } = fixture([false]);

  await fixes.startConflictResolve('acme/app', 7, 'alice', options);

  assert.deepEqual(calls, ['clone', 'fetch', 'worktree', 'create', 'owner:repair-1', 'stop']);
});

test('a cancellation after goal-mode setup still prevents the first prompt', async () => {
  const { fixes, calls, options } = fixture([true, false]);

  await fixes.startConflictResolve('acme/app', 7, 'alice', options);

  assert.deepEqual(calls, ['clone', 'fetch', 'worktree', 'create', 'owner:repair-1', 'link', 'goal', 'stop']);
});

test('a fresh goal run also exposes ownership before its first prompt', async () => {
  const { fixes, calls, options } = fixture([false]);

  await fixes.createGoalRun({
    kind: 'implement',
    title: 'Implement task',
    repo: 'acme/app',
    branchPrefix: 'companion/task-1',
    baseBranch: 'main',
    objective: 'Implement the bounded task.',
    userId: 'alice',
    ...options,
  });

  assert.deepEqual(calls, ['clone', 'goal-worktree', 'create', 'owner:repair-1', 'stop']);
});

test('a fresh run stops before creating a worktree when trusted repository guidance cannot be loaded', async () => {
  const { fixes, calls } = fixture([true], async () => {
    throw new Error('repository guidance unavailable');
  });

  await assert.rejects(
    fixes.createGoalRun({
      kind: 'implement',
      title: 'Implement task',
      repo: 'acme/app',
      branchPrefix: 'companion/task-1',
      baseBranch: 'main',
      objective: 'Implement the bounded task.',
      userId: 'alice',
    }),
    /repository guidance unavailable/,
  );

  assert.deepEqual(calls, []);
});

test('a PR repair also stops before creating a worktree when trusted guidance cannot be loaded', async () => {
  const { fixes, calls } = fixture([true], async () => {
    throw new Error('repository guidance unavailable');
  });

  await assert.rejects(
    fixes.startCustomPrRun('acme/app', 7, 'Apply the requested cleanup.', 'alice'),
    /repository guidance unavailable/,
  );

  assert.deepEqual(calls, []);
});
