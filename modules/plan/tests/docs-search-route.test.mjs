import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import routeFactory from '../dist/api/routes.js';

const alice = { username: 'alice', displayName: 'Alice', role: 'admin' };

/**
 * The retrieval search route must clamp its inputs like the file's other list
 * routes: a negative or absurd limit reached SQLite verbatim (negative LIMIT
 * means unlimited) and q had no length cap.
 */
function fixture() {
  const searches = [];
  const services = {
    plan: {
      docs: {
        search: (workspaceId, q, limit) => {
          searches.push({ workspaceId, q, limit });
          return [];
        },
      },
    },
    code: {},
    workspace: { requireAccessible: (_user, id) => ({ id }) },
  };
  // Store classes are lazy over ctx.db; the search route never touches them.
  const db = new Database(':memory:');
  const routes = routeFactory({
    db,
    services: { get: (id) => services[id] },
    rbac: { has: () => true, allows: () => true },
    broadcast: () => {},
    audit: { record: () => {} },
    isEnabled: () => true,
  });
  const search = (params) => {
    const target = routes.find(
      (candidate) => candidate.method === 'GET' && candidate.path === '/api/workspaces/:id/docs/search',
    );
    assert.ok(target, 'search route exists');
    return target.run({ id: 'ws-1' }, new URLSearchParams(params), {}, alice, null, '127.0.0.1');
  };
  return { search, searches };
}

test('docs search clamps limit into [1,25] and rejects out-of-range values', async () => {
  const fx = fixture();
  await fx.search({ q: 'auth flow' });
  assert.equal(fx.searches.at(-1).limit, 8, 'default limit');

  await fx.search({ q: 'auth flow', limit: '25' });
  assert.equal(fx.searches.at(-1).limit, 25);

  for (const limit of ['-5', '0', '26', 'abc']) {
    await assert.rejects(() => fx.search({ q: 'auth flow', limit }), (err) => err.status === 400);
  }
  assert.equal(fx.searches.length, 2, 'invalid limits never reach the store');
});

test('docs search bounds q like the other list routes', async () => {
  const fx = fixture();
  await assert.rejects(() => fx.search({ q: 'x'.repeat(201) }), (err) => err.status === 400);
  assert.equal(fx.searches.length, 0);

  await fx.search({ q: 'x'.repeat(200) });
  assert.equal(fx.searches.length, 1);
});
