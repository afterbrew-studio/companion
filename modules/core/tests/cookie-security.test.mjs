import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
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
 * The session cookie's `Secure` flag. COMPANION_PUBLIC_URL states the canonical
 * URL and a trusted proxy's X-Forwarded-Proto states what the browser actually
 * spoke; either is enough, neither is required. The failure this pins is the
 * silent downgrade: TLS terminated at a proxy while publicUrl was never set,
 * which left the browser free to resend that session over plain HTTP.
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

async function harness(t, { publicUrl, trustedProxies = [] } = {}) {
  const db = new Database(':memory:');
  for (const migration of migrations) migration.up(db);
  const sessions = new SessionsStore(db);
  const users = new UsersStore(db, sessions);
  const settings = new SettingsStore(db);
  const roles = new RolesService(new RolesStore(db), users, rbacStub, () => {}, { record() {} }, noopLog);
  const mfa = new Mfa(memorySecrets(), new MfaStore(db), users);
  const auth = new Auth(users, sessions, new ApiTokensStore(db), settings, rbacStub, roles, mfa);
  auth.createUser({ username: 'ann', email: '', password: 'password-1', role: 'business' });

  const ctx = {
    config: { publicUrl, authMode: 'password', host: '0.0.0.0', github: { host: 'github.com' } },
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

  const router = new DynamicRouter(auth, noopLog, () => {}, { trustedProxies });
  router.mount('core', routes(ctx));

  const server = createServer((req, res) => void router.dispatch(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    server.close();
    db.close();
  });

  // The test peer is always 127.0.0.1, so whether that address is trusted is
  // what decides if the forwarded protocol is believed.
  const login = async (forwardedProto) => {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: {
        'x-companion-csrf': '1',
        'content-type': 'application/json',
        ...(forwardedProto ? { 'x-forwarded-proto': forwardedProto } : {}),
      },
      body: JSON.stringify({ username: 'ann', password: 'password-1' }),
    });
    assert.equal(res.status, 200);
    return res.headers.get('set-cookie') ?? '';
  };
  return { base, login };
}

test('a plain http instance with no proxy leaves the cookie unmarked', async (t) => {
  // Secure on a http://localhost dev instance would make the browser drop the
  // cookie outright, so an absent signal must stay absent.
  const h = await harness(t);
  assert.doesNotMatch(await h.login(), /;\s*Secure/);
});

test('the configured public URL still marks the cookie on its own', async (t) => {
  const h = await harness(t, { publicUrl: 'https://companion.example.test' });
  assert.match(await h.login(), /;\s*Secure/);
});

test('a trusted proxy reporting https marks the cookie without any public URL', async (t) => {
  const h = await harness(t, { trustedProxies: ['127.0.0.1'] });
  assert.match(await h.login('https'), /;\s*Secure/);
});

test('a trusted proxy reporting http does not mark it', async (t) => {
  const h = await harness(t, { trustedProxies: ['127.0.0.1'] });
  assert.doesNotMatch(await h.login('http'), /;\s*Secure/);
});

test('X-Forwarded-Proto from an untrusted peer cannot claim https', async (t) => {
  // Nothing declares a trusted proxy, so the header is the caller's own word.
  const h = await harness(t);
  assert.doesNotMatch(await h.login('https'), /;\s*Secure/);
});

test('logout clears the cookie with the same flag it was set with', async (t) => {
  const h = await harness(t, { trustedProxies: ['127.0.0.1'] });
  const cookie = await h.login('https');
  const token = decodeURIComponent(/companion\.session=([^;]*)/.exec(cookie)?.[1] ?? '');

  const res = await fetch(`${h.base}/api/auth/logout`, {
    method: 'POST',
    headers: {
      'x-companion-csrf': '1',
      'x-forwarded-proto': 'https',
      cookie: `companion.session=${encodeURIComponent(token)}`,
    },
  });

  assert.equal(res.status, 200);
  assert.match(res.headers.get('set-cookie') ?? '', /Max-Age=0.*;\s*Secure/);
});
