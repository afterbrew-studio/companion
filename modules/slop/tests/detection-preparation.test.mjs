import assert from 'node:assert/strict';
import test from 'node:test';
import { SlopService } from '../dist/api/slop-service.js';

function serviceWith(checkouts) {
  const store = {
    disabledBuiltins: () => new Set(),
    listRules: () => [],
    insertDetection: () => {},
    setProvenance: () => {},
    finishDetection: () => true,
  };
  const code = {
    prs: {
      get: () => ({
        repo: 'moxxy-ai/companion',
        number: 158,
        title: 'Build Desk',
        body: '',
        author: 'moxxy-ai',
        headRef: 'feature/desk',
        baseRef: 'main',
        draft: false,
        labels: [],
      }),
    },
    repos: { get: () => ({ workspace_id: 'ws-default' }) },
  };
  const unavailable = async () => {
    throw new Error('unavailable in test');
  };
  const github = { pull: unavailable, prCommits: unavailable, user: unavailable };
  return new SlopService(
    store,
    code,
    {},
    checkouts,
    () => github,
    () => undefined,
    () => 'needs-evidence',
    () => {},
    () => {},
  );
}

test('the first PR assessment prepares its clone instead of rejecting a missing cache', async () => {
  let cloneCalled = false;
  let worktreeCalled = false;
  const service = serviceWith({
    hasClone: () => false,
    clone: async () => {
      cloneCalled = true;
    },
    withPullRequestWorktree: async () => {
      worktreeCalled = true;
      throw new Error('stop after checkout preparation');
    },
  });

  assert.doesNotThrow(() => service.validateDetect('moxxy-ai/companion', 158, 'admin'));
  const result = await service.detect('moxxy-ai/companion', 158, 'admin');

  assert.equal(cloneCalled, true);
  assert.equal(worktreeCalled, true);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /stop after checkout preparation/);
});
