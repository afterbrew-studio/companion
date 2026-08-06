import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { DynamicRouter, HttpError, route } from '../dist/server/index.js';

const log = { info() {}, warn() {}, error() {}, debug() {} };

async function harness(t) {
  const calls = [];
  const audited = [];
  const grants = {
    maintainer: new Set(['first:read', 'second:act']),
    limited: new Set(['first:read']),
  };
  const users = {
    human: { username: 'maintainer', displayName: 'Maintainer', role: 'maintainer' },
    limited: { username: 'limited', displayName: 'Limited', role: 'maintainer' },
    delegate: {
      username: 'maintainer',
      displayName: 'Maintainer',
      role: 'maintainer',
      sessionAccess: 'read-only',
    },
    scoped: {
      username: 'maintainer',
      displayName: 'Maintainer',
      role: 'maintainer',
      permissionScope: ['first:read'],
    },
  };
  const router = new DynamicRouter(
    {
      verify: (token) => users[token ?? ''] ?? null,
      require: (user, permission) => {
        if (!user) throw new HttpError(401, 'authentication required');
        if (!grants[user.username]?.has(permission)) throw new HttpError(403, `requires ${permission}`);
      },
    },
    log,
    (event) => audited.push(event),
  );
  router.mount('probe', [
    route({
      method: 'GET',
      path: '/read',
      access: 'any',
      handler: () => (calls.push('read'), { ok: true }),
    }),
    route({
      method: 'POST',
      path: '/write',
      access: 'any',
      handler: () => (calls.push('write'), { ok: true }),
    }),
    route({
      method: 'POST',
      path: '/prepare',
      access: ['first:read', 'second:act'],
      allowDelegatedWrite: true,
      handler: () => (calls.push('prepare'), { ok: true }),
    }),
    route({
      method: 'GET',
      path: '/scoped-bootstrap',
      access: 'any',
      allowScopedToken: true,
      handler: () => (calls.push('scoped-bootstrap'), { ok: true }),
    }),
  ]);

  const server = createServer((req, res) => void router.dispatch(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());

  const call = async (method, path, token) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: response.status, body: await response.json() };
  };
  return { call, calls, audited };
}

test('delegated sessions may read and prepare, but the router blocks ordinary writes', async (t) => {
  const h = await harness(t);

  assert.equal((await h.call('GET', '/read', 'delegate')).status, 200);
  assert.equal((await h.call('POST', '/prepare', 'delegate')).status, 200);
  const denied = await h.call('POST', '/write', 'delegate');

  assert.equal(denied.status, 403);
  assert.match(denied.body.error, /read-only/);
  assert.deepEqual(h.calls, ['read', 'prepare']);
  assert.deepEqual(
    h.audited.map((event) => [event.action, event.actor, event.status]),
    [
      ['POST /prepare', 'maintainer', 200],
      ['POST /write', 'maintainer', 403],
    ],
  );
});

test('a normal human session keeps the existing write behavior', async (t) => {
  const h = await harness(t);

  assert.equal((await h.call('POST', '/write', 'human')).status, 200);
  assert.deepEqual(h.calls, ['write']);
});

test('scoped API tokens cannot reach an unscoped route without an explicit exception', async (t) => {
  const h = await harness(t);

  const denied = await h.call('GET', '/read', 'scoped');
  assert.equal(denied.status, 403);
  assert.match(denied.body.error, /unscoped route/);
  assert.equal((await h.call('GET', '/scoped-bootstrap', 'scoped')).status, 200);
  assert.deepEqual(h.calls, ['scoped-bootstrap']);
});

test('permission arrays are an AND enforced centrally before the handler', async (t) => {
  const h = await harness(t);

  const denied = await h.call('POST', '/prepare', 'limited');
  assert.equal(denied.status, 403);
  assert.match(denied.body.error, /second:act/);
  assert.deepEqual(h.calls, []);
  assert.equal(h.audited[0].access, 'first:read & second:act');
});
