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
      scope: 'delegated',
      workspaceIds: ['ws-target'],
      ownerId: 'maintainer',
      createdAt: 1,
    },
  ];
  const store = {
    githubAccounts: { list: () => accounts },
    repos: {
      get: (fullName) =>
        fullName === 'moxxy-ai/companion' ? { full_name: fullName, workspace_id: repoWorkspace } : undefined,
    },
  };
  return new GitHubAccounts(store);
}

test('add-repo resolution uses the requested workspace for a maintainer account', async () => {
  const accounts = fixture();

  const { row, tried } = await accounts.verifiedRowFor('fetch', 'moxxy-ai/companion', {
    workspaceId: 'ws-target',
    username: 'maintainer',
  });

  assert.equal(row?.id, 'gha-maintainer');
  assert.deepEqual(tried, []);
});
