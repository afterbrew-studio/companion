import assert from 'node:assert/strict';
import test from 'node:test';
import routes from '../dist/api/routes.js';

function harness() {
  const limits = [];
  const ctx = {
    services: {
      get: (id) =>
        id === 'notify'
          ? {
              deliveriesFor: (_userId, _scopes, limit) => {
                limits.push(limit);
                return [];
              },
            }
          : { accessibleIds: () => [], repoNames: () => [], canAccessRepo: () => false },
    },
  };
  const [deliveries] = routes(ctx);
  const call = (search) =>
    deliveries.run({}, new URLSearchParams(search), undefined, { username: 'ana', role: 'admin' }, null, '127.0.0.1');
  return { call, limits };
}

test('the deliveries limit is passed through to the service, bounded 1..500', async () => {
  const { call, limits } = harness();

  await call('');
  await call('limit=250');
  assert.deepEqual(limits, [undefined, 250]);

  for (const bad of ['limit=0', 'limit=-1', 'limit=501', 'limit=2.5', 'limit=abc']) {
    await assert.rejects(call(bad), (err) => err.status === 400 && /limit/.test(err.message), bad);
  }
  assert.deepEqual(limits, [undefined, 250], 'a refused limit never reaches the service');
});
