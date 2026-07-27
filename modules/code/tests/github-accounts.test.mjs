import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubAccounts } from '../dist/api/github-accounts.js';

function fixture({ repoWorkspace = 'ws-existing' } = {}) {
  const accounts = [
    {
      id: 'gha-maintainer',
      login: 'maintainer-gh',
      token: 'test-token',
      purposes: ['fetch'],
      scope: 'selected',
      workspaceIds: ['ws-target'],
      ownerId: 'maintainer',
      createdAt: 1,
    },
  ];
  const store = {
    // The resolver consults per-repo bindings before falling back to scope, so
    // the stub has to answer that too: "no binding" is the interesting default.
    githubAccounts: { list: () => accounts, binding: () => null, bindingsFor: () => ({}) },
    repos: {
      get: (fullName) =>
        fullName === 'moxxy-ai/companion' ? { full_name: fullName, workspace_id: repoWorkspace } : undefined,
      workspaceIds: () => [repoWorkspace],
    },
  };
  return new GitHubAccounts(store);
}

test('unowned legacy accounts are invisible and never resolve', () => {
  const legacy = {
    id: 'legacy-shared', login: 'server-account', token: 'legacy-token', purposes: ['fetch'],
    scope: 'all', workspaceIds: [], ownerId: null, createdAt: 0,
  };
  const store = {
    githubAccounts: { list: () => [legacy], binding: () => null, bindingsFor: () => ({}) },
    repos: { workspaceIds: () => ['ws-a'] },
  };
  const accounts = new GitHubAccounts(store);

  assert.deepEqual(accounts.list(), []);
  assert.equal(accounts.tokenFor('fetch', { repo: 'acme/private', username: 'admin' }), null);
  assert.equal(accounts.tokenFor('fetch', { repo: 'acme/private', username: null }), null);
});

test('add-repo resolution uses the requested workspace for a maintainer account', async () => {
  const accounts = fixture();

  const { row, tried } = await accounts.verifiedRowFor('fetch', 'moxxy-ai/companion', {
    workspaceId: 'ws-target',
    username: 'maintainer',
  });

  assert.equal(row?.id, 'gha-maintainer');
  assert.deepEqual(tried, []);
});

test('a personal account is never usable by another profile or background work', () => {
  const accounts = fixture();

  assert.equal(
    accounts.tokenFor('fetch', { repo: 'moxxy-ai/companion', workspaceId: 'ws-target', username: 'someone-else' }),
    null,
  );
  assert.equal(
    accounts.tokenFor('fetch', { repo: 'moxxy-ai/companion', workspaceId: 'ws-target', username: null }),
    null,
  );
});

test('purpose and selected-workspace boundaries are enforced for every personal account', () => {
  const accounts = fixture();

  assert.equal(
    accounts.tokenFor('runs', { repo: 'moxxy-ai/companion', workspaceId: 'ws-target', username: 'maintainer' }),
    null,
  );
  assert.equal(
    accounts.tokenFor('fetch', { repo: 'moxxy-ai/companion', workspaceId: 'ws-other', username: 'maintainer' }),
    null,
  );
});
