import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubSync } from '../dist/api/github-sync.js';

test('workspace refresh uses workspace-scoped credentials and reports only unavailable repos', async () => {
  const resolved = [];
  const synced = [];
  const store = {
    repos: {
      listByWorkspace: () => [{ full_name: 'acme/readable' }, { full_name: 'acme/private' }],
      get: () => ({ last_sync_at: null }),
      setSynced: (repo) => synced.push(repo),
    },
    issues: { upsert() {} },
    prs: { upsert() {}, setComments() {} },
  };
  const client = {
    issues: async () => [],
    pulls: async () => [],
  };
  const sync = new GitHubSync(
    store,
    async (repo, workspaceId, username) => {
      resolved.push([repo, workspaceId, username]);
      return repo === 'acme/readable' ? client : null;
    },
    () => undefined,
  );

  const result = await sync.syncWorkspace('ws-product', 'maintainer');

  assert.deepEqual(resolved, [
    ['acme/readable', 'ws-product', 'maintainer'],
    ['acme/private', 'ws-product', 'maintainer'],
  ]);
  assert.deepEqual(synced, ['acme/readable']);
  assert.deepEqual(result, { unavailableRepos: ['acme/private'] });
});
