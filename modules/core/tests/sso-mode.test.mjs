import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '@moxxy/companion-services';
import { DynamicRouter } from '@moxxy/companion-core/server';
import migrations from '../dist/api/migrations.js';
import { ApiTokensStore } from '../dist/api/api-tokens-store.js';
import { Auth } from '../dist/api/auth.js';
import { Mfa } from '../dist/api/mfa.js';
import { MfaStore } from '../dist/api/mfa-store.js';
import { RolesService } from '../dist/api/roles-service.js';
import { RolesStore } from '../dist/api/roles-store.js';
import { SessionsStore } from '../dist/api/sessions-store.js';
import { SettingsStore } from '../dist/api/settings-store.js';
import { UsersStore } from '../dist/api/users-store.js';
import routes from '../dist/api/routes.js';

/**
 * COMPANION_AUTH_MODE=sso: password sign-in is closed so IdP policy (MFA,
 * offboarding) cannot be bypassed, while the documented recovery paths (the
 * bootstrap token for an empty instance) keep working.
 */

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

const rbacStub = {
  has: () => true,
  allows: () => true,
  permissionsFor: () => [],
  catalog: () => [],
  roles: () => ['admin', 'business'],
  hasRole: (role) => ['admin', 'business'].includes(role),
  baseline: () => [],
  explain: () => { throw new Error('unused'); },
};

function memorySecrets() {
  const values = new Map();
  return {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => void values.set(key, value),
    delete: (key) => void values.delete(key),
    keys: () => [...values.keys()],
  };
}

async function harness(t) {
  const db = new Database(':memory:');
  for (const migration of migrations) migration.up(db);
  const sessions = new SessionsStore(db);
  const users = new UsersStore(db, sessions);
  const settings = new SettingsStore(db);
  const roles = new RolesService(new RolesStore(db), users, rbacStub, () => {}, { record() {} }, noopLog);
  const mfa = new Mfa(memorySecrets(), new MfaStore(db), users);
  const auth = new Auth(users, sessions, new ApiTokensStore(db), settings, rbacStub, roles, mfa);

  const ctx = {
    config: { publicUrl: undefined, authMode: 'sso', host: '0.0.0.0', github: { host: 'github.com' } },
    appVersion: 'test',
    log: noopLog,
    rbac: rbacStub,
    broadcast() {},
    bus: { emit() {} },
    audit: { record() {} },
    modules: { list: () => [] },
    services: {
      get: (id) =>
        ({
          core: auth,
          roles,
          settings,
          mfa,
          audit: { list: () => [], record() {} },
          auditForwarder: { state: () => ({}) },
        })[id],
    },
  };

  const router = new DynamicRouter(auth, noopLog, () => {});
  router.mount('core', routes(ctx));

  const server = createServer((req, res) => void router.dispatch(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    server.close();
    db.close();
  });

  const call = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'x-companion-csrf': '1', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const cookie = res.headers.get('set-cookie');
    const sessionToken = cookie ? decodeURIComponent(/companion\.session=([^;]*)/.exec(cookie)?.[1] ?? '') : null;
    return { status: res.status, body: await res.json(), sessionToken };
  };
  return { call, auth };
}

test('sso mode refuses password login with a clear message', async (t) => {
  const h = await harness(t);
  h.auth.createUser({ username: 'ann', email: '', password: 'password-1', role: 'business' });

  const res = await h.call('POST', '/api/auth/login', { username: 'ann', password: 'password-1' });

  assert.equal(res.status, 403);
  assert.match(res.body.error, /single sign-on/i);
});

test('sso mode advertises itself and local-session bootstrap stays closed', async (t) => {
  const h = await harness(t);

  const state = await h.call('GET', '/api/auth/state');
  assert.equal(state.status, 200);
  assert.equal(state.body.authMode, 'sso');
  assert.equal(state.body.setup, true);

  const local = await h.call('POST', '/api/auth/local-session');
  assert.equal(local.status, 403);
});

test('an empty instance in sso mode still creates its first admin via the bootstrap token', async (t) => {
  const h = await harness(t);
  const dir = mkdtempSync(join(tmpdir(), 'companion-sso-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const token = 'b'.repeat(40);
  assert.equal(h.auth.prepareBootstrap(token, join(dir, 'bootstrap-token')), 'environment');

  const setup = await h.call('POST', '/api/auth/setup', {
    username: 'root',
    email: 'root@example.test',
    password: 'password-123',
    bootstrapToken: token,
  });

  assert.equal(setup.status, 200);
  assert.equal(setup.body.user.role, 'admin');
  assert.ok(setup.sessionToken, 'setup signs the first admin in with a real session');
  assert.equal(h.auth.verify(setup.sessionToken)?.username, 'root');
});
