import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import routeFactory from '../dist/api/routes.js';
import migrations from '../dist/api/migrations.js';

const alice = { username: 'alice', displayName: 'Alice', role: 'admin' };

/**
 * Mutations the sidebar reflects live must announce themselves: account edits
 * via repos.changed, label writes via a re-sync of the labelled row. A silent
 * PATCH leaves every other client stale until an unrelated refresh.
 */
function fixture() {
  const broadcasts = [];
  const synced = [];
  const code = {
    githubAccounts: {
      row: (id) => (id === 'gh-1' ? { id, ownerId: 'alice', scope: 'all', workspaceIds: [], purposes: ['fetch'] } : null),
      update: (id, fields) => ({ id, ...fields }),
      performForRepo: async (_purpose, _repo, work) => ({ result: await work({ addLabels: async () => {} }) }),
    },
    issues: {
      get: (repo, number) => (repo === 'acme/app' && number === 7 ? { repo, number, state: 'open' } : null),
    },
    prs: { get: () => null },
    sync: {
      syncIssue: async (repo, number, username) => {
        synced.push({ repo, number, username });
      },
    },
  };
  const services = {
    code,
    operate: {},
    workspace: { canAccessRepo: () => true },
    settings: {},
    reports: {},
  };
  const db = new Database(':memory:');
  for (const migration of migrations) migration.up(db);
  const routes = routeFactory({
    db,
    services: { get: (id) => services[id] },
    rbac: { has: () => true, allows: () => true },
    broadcast: (message) => broadcasts.push(message),
    audit: { record: () => {} },
    isEnabled: () => true,
  });
  const run = (method, path, params, body, user) => {
    const target = routes.find((candidate) => candidate.method === method && candidate.path === path);
    assert.ok(target, `${method} ${path} route exists`);
    return target.run(params, new URLSearchParams(), body, user, null, '127.0.0.1');
  };
  return { broadcasts, synced, run };
}

test('PATCH /api/github/accounts/:id broadcasts repos.changed like its siblings', async () => {
  const fx = fixture();
  await fx.run('PATCH', '/api/github/accounts/:id', { id: 'gh-1' }, { purposes: ['fetch', 'runs'] }, alice);
  assert.deepEqual(fx.broadcasts, [{ t: 'repos.changed' }]);
});

test('adding issue labels re-syncs the issue like the PR twin', async () => {
  const fx = fixture();
  await fx.run(
    'POST',
    '/api/repos/:owner/:name/issues/:number/labels',
    { owner: 'acme', name: 'app', number: '7' },
    { labels: ['bug'] },
    alice,
  );
  assert.deepEqual(fx.synced, [{ repo: 'acme/app', number: 7, username: 'alice' }]);
});
