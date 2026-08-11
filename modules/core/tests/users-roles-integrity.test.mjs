import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { Database } from '@moxxy/companion-services';
import { DynamicRouter, HttpError } from '@moxxy/companion-core/server';
import migrations from '../dist/api/migrations.js';
import { ApiTokensStore } from '../dist/api/api-tokens-store.js';
import { Auth } from '../dist/api/auth.js';
import { RolesService } from '../dist/api/roles-service.js';
import { RolesStore } from '../dist/api/roles-store.js';
import { SessionsStore } from '../dist/api/sessions-store.js';
import { SettingsStore } from '../dist/api/settings-store.js';
import { UsersStore } from '../dist/api/users-store.js';
import routes from '../dist/api/routes.js';

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

const rbacStub = {
  has: () => true,
  allows: () => true,
  permissionsFor: () => ['users:manage'],
  catalog: () => [{ id: 'widgets:read', title: 'Read widgets', owner: 'widgets', implies: [] }],
  roles: () => ['admin', 'maintainer', 'business'],
  hasRole: (role) => ['admin', 'maintainer', 'business'].includes(role),
  baseline: () => [],
  explain: () => { throw new Error('unused'); },
};

function harness() {
  const db = new Database(':memory:');
  for (const migration of migrations) migration.up(db);
  const sessions = new SessionsStore(db);
  const users = new UsersStore(db, sessions);
  const settings = new SettingsStore(db);
  const rolesStore = new RolesStore(db);
  const roles = new RolesService(rolesStore, users, rbacStub, () => {}, { record() {} }, noopLog);
  const auth = new Auth(users, sessions, new ApiTokensStore(db), settings, rbacStub, roles);
  return { db, users, settings, auth, roles, rolesStore };
}

test('email dedup migration keeps the oldest row and the unique index holds afterwards', () => {
  const db = new Database(':memory:');
  for (const migration of migrations) {
    if (migration.version >= 7) break;
    migration.up(db);
  }
  const insert = db.prepare(
    `INSERT INTO users (username, display_name, email, password_hash, role, disabled, created_at)
     VALUES (?, '', ?, 'x', 'business', 0, ?)`,
  );
  insert.run('oldest', 'dup@example.com', 1_000);
  insert.run('newer', 'dup@example.com', 2_000);
  insert.run('newest', 'dup@example.com', 3_000);
  insert.run('other', 'unique@example.com', 1_500);
  insert.run('blank-a', '', 500);
  insert.run('blank-b', '', 600);

  for (const migration of migrations) {
    if (migration.version >= 7) migration.up(db);
  }

  const email = (u) => db.prepare(`SELECT email FROM users WHERE username = ?`).get(u).email;
  assert.equal(email('oldest'), 'dup@example.com', 'the oldest row keeps its email');
  assert.equal(email('newer'), '');
  assert.equal(email('newest'), '');
  assert.equal(email('other'), 'unique@example.com');
  assert.equal(email('blank-a'), '', 'blank sentinel rows are untouched');

  assert.throws(
    () => insert.run('intruder', 'dup@example.com', 4_000),
    /UNIQUE/,
    'the partial unique index refuses a new duplicate',
  );
  insert.run('blank-c', '', 700);
  db.close();
});

test('duplicate emails are refused with a 400 on create and both update paths', () => {
  const { db, auth } = harness();
  auth.createUser({ username: 'ann', email: 'ann@example.com', password: 'password-1', role: 'admin' });
  auth.createUser({ username: 'bob', email: 'bob@example.com', password: 'password-1', role: 'business' });

  const taken = (fn) => {
    assert.throws(fn, (err) => err.status === 400 && /already in use/.test(err.message));
  };
  taken(() => auth.createUser({ username: 'cid', email: 'ann@example.com', password: 'password-1', role: 'business' }));
  taken(() => auth.updateUser('bob', { email: 'ann@example.com' }));
  taken(() => auth.updateOwnAccount('bob', { email: 'ann@example.com' }));

  // Re-asserting your own email is not a conflict, and '' stays shareable.
  auth.updateOwnAccount('ann', { email: 'ann@example.com' });
  auth.updateUser('ann', { email: '' });
  auth.updateUser('bob', { email: '' });
  db.close();
});

test('revoke validates the permission id against the catalog exactly like grant', () => {
  const { db, auth, roles, rolesStore } = harness();
  auth.createUser({ username: 'root', email: 'root@example.com', password: 'password-1', role: 'admin' });

  assert.throws(() => roles.grant('root', 'business', ['junk:perm']), /no enabled module declares 'junk:perm'/);
  assert.throws(() => roles.revoke('root', 'business', ['junk:perm']), /no enabled module declares 'junk:perm'/);
  assert.equal(
    rolesStore.overridesFor('business').length,
    0,
    'a refused grant or revoke leaves no junk override row behind',
  );

  roles.revoke('root', 'business', ['widgets:read']);
  assert.deepEqual(rolesStore.overridesFor('business'), [
    { role: 'business', permission: 'widgets:read', mode: 'revoke' },
  ]);
  db.close();
});

async function routeHarness(t) {
  const h = harness();
  const broadcasts = [];
  const ctx = {
    config: { publicUrl: undefined, authMode: 'password', host: '127.0.0.1', github: { host: 'github.com' } },
    appVersion: 'test',
    log: noopLog,
    rbac: rbacStub,
    broadcast: (message) => broadcasts.push(message.t),
    bus: { emit() {} },
    audit: { record() {} },
    modules: { list: () => [] },
    services: {
      get: (id) =>
        ({
          core: h.auth,
          roles: h.roles,
          settings: h.settings,
          audit: { list: () => [], record() {} },
          auditForwarder: { state: () => ({}) },
        })[id],
    },
  };

  const admin = { username: 'root', role: 'admin', permissions: ['users:manage'] };
  h.auth.createUser({ username: 'root', email: 'root@example.com', password: 'password-1', role: 'admin' });

  const router = new DynamicRouter(
    {
      verify: (token) => (token === 'root' ? admin : null),
      require: (user, permission) => {
        if (permission === 'public' || permission === 'any') return;
        if (!user?.permissions.includes(permission)) throw new HttpError(403, `requires ${permission}`);
      },
    },
    noopLog,
    () => {},
  );
  router.mount('core', routes(ctx));

  const server = createServer((req, res) => void router.dispatch(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    server.close();
    h.db.close();
  });

  const call = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: 'Bearer root', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  return { call, broadcasts };
}

test('GET /api/users refuses an unknown role filter and a zero limit', async (t) => {
  const { call } = await routeHarness(t);

  const unknownRole = await call('GET', '/api/users?role=bogus');
  assert.equal(unknownRole.status, 400);
  assert.match(unknownRole.body.error, /unknown role/);

  const zeroLimit = await call('GET', '/api/users?limit=0');
  assert.equal(zeroLimit.status, 400);
  assert.match(zeroLimit.body.error, /limit/);

  const ok = await call('GET', '/api/users?role=admin&limit=5');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.users.length, 1);
});

test('user and role mutations broadcast users.changed and roles.changed', async (t) => {
  const { call, broadcasts } = await routeHarness(t);

  const createUser = await call('POST', '/api/users', {
    username: 'ann',
    password: 'password-1',
    role: 'business',
  });
  assert.equal(createUser.status, 201);
  assert.deepEqual(broadcasts, ['users.changed']);

  broadcasts.length = 0;
  assert.equal((await call('PATCH', '/api/users/ann', { displayName: 'Ann' })).status, 200);
  assert.deepEqual(broadcasts, ['users.changed']);

  broadcasts.length = 0;
  assert.equal((await call('POST', '/api/roles/business/permissions', { mode: 'grant', permissions: ['widgets:read'] })).status, 200);
  assert.deepEqual(broadcasts, ['roles.changed']);

  broadcasts.length = 0;
  assert.equal((await call('DELETE', '/api/users/ann')).status, 200);
  assert.ok(broadcasts.includes('users.changed'));
});
