import assert from 'node:assert/strict';
import test from 'node:test';
import { GitHubError } from '../dist/api/github-client.js';
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
  assert.deepEqual(result, { unavailableRepos: ['acme/private'], failedRepos: [] });
});

/** A workspace of one repo whose fetch fails with `err`. */
async function refreshFailingWith(err) {
  const store = {
    repos: {
      listByWorkspace: () => [{ full_name: 'acme/app' }],
      get: () => ({ last_sync_at: null }),
      setSynced() {},
    },
    issues: { upsert() {} },
    prs: { upsert() {}, setComments() {} },
  };
  const client = {
    issues: async () => {
      throw err;
    },
    pulls: async () => [],
  };
  const sync = new GitHubSync(store, () => client, () => undefined);
  return sync.syncWorkspace('ws-product', 'maintainer');
}

// The cached rows of a repo stay hidden only on a real access verdict, so
// everything else has to land in `failedRepos`: reporting it as missing access
// sends the reader to GitHub's permission settings for nothing.
test('a repository GitHub will not show is unavailable', async () => {
  const result = await refreshFailingWith(new GitHubError('GitHub /repos/acme/app/issues: Not Found', 404));

  assert.deepEqual(result, { unavailableRepos: ['acme/app'], failedRepos: [] });
});

test('a spent rate budget is a failed refresh, not missing access', async () => {
  const err = new GitHubError('GitHub /repos/acme/app/issues: API rate limit exceeded', 403, true);

  const result = await refreshFailingWith(err);

  assert.deepEqual(result, {
    unavailableRepos: [],
    failedRepos: [{ repo: 'acme/app', reason: 'GitHub /repos/acme/app/issues: API rate limit exceeded' }],
  });
});

test('a local failure is reported with its own reason', async () => {
  const result = await refreshFailingWith(new Error("Unknown named parameter 'draft'"));

  assert.deepEqual(result, {
    unavailableRepos: [],
    failedRepos: [{ repo: 'acme/app', reason: "Unknown named parameter 'draft'" }],
  });
});
