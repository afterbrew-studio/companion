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
import { base32Decode, totpCode } from '../dist/api/totp.js';
import routes from '../dist/api/routes.js';

/**
 * The MFA login flow over real HTTP through the real router with the real Auth
 * as authenticator, because what matters is what a caller can and cannot reach
 * BEFORE the second factor: no session may exist between password and code.
 */

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

const rbacStub = {
  has: () => true,
  allows: (user, permission) => user?.role === 'admin' || permission !== 'users:manage',
  permissionsFor: () => ['users:manage'],
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

async function harness(t, { authMode = 'password' } = {}) {
  const db = new Database(':memory:');
  for (const migration of migrations) migration.up(db);
  const sessions = new SessionsStore(db);
  const users = new UsersStore(db, sessions);
  const settings = new SettingsStore(db);
  const roles = new RolesService(new RolesStore(db), users, rbacStub, () => {}, { record() {} }, noopLog);
  const mfa = new Mfa(memorySecrets(), new MfaStore(db), users);
  const auth = new Auth(users, sessions, new ApiTokensStore(db), settings, rbacStub, roles, mfa);

  const broadcasts = [];
  const ctx = {
    config: { publicUrl: undefined, authMode, host: '127.0.0.1', github: { host: 'github.com' } },
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

  const call = async (method, path, { token, body } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        // The browser request proof the router demands of every cookie/anonymous mutation.
        'x-companion-csrf': '1',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const cookie = res.headers.get('set-cookie');
    const sessionToken = cookie ? decodeURIComponent(/companion\.session=([^;]*)/.exec(cookie)?.[1] ?? '') : null;
    return { status: res.status, body: await res.json(), sessionToken };
  };

  return { call, auth, users, broadcasts };
}

const step = () => Math.floor(Date.now() / 30_000);

/** Password login, enroll, confirm; returns the signed-in token and secret. */
async function enroll(h, username, password) {
  const login = await h.call('POST', '/api/auth/login', { body: { username, password } });
  assert.equal(login.status, 200);
  const token = login.sessionToken;
  const provision = await h.call('POST', '/api/mfa/enroll', { token });
  assert.equal(provision.status, 200);
  const secret = base32Decode(provision.body.secret);
  const confirm = await h.call('POST', '/api/mfa/confirm', { token, body: { code: totpCode(secret, step()) } });
  assert.equal(confirm.status, 200);
  return { token, secret, recoveryCodes: confirm.body.recoveryCodes };
}

test('login without MFA is unchanged', async (t) => {
  const h = await harness(t);
  h.auth.createUser({ username: 'ann', email: '', password: 'password-1', role: 'business' });

  const res = await h.call('POST', '/api/auth/login', { body: { username: 'ann', password: 'password-1' } });

  assert.equal(res.status, 200);
  assert.equal(res.body.user.username, 'ann');
  assert.equal(res.body.mfaRequired, undefined);
  assert.ok(res.sessionToken, 'a session cookie is set immediately');
  const me = await h.call('GET', '/api/auth/me', { token: res.sessionToken });
  assert.equal(me.status, 200);
});

test('enrollment: provision, confirm with a valid code, then the account is protected', async (t) => {
  const h = await harness(t);
  h.auth.createUser({ username: 'ann', email: '', password: 'password-1', role: 'business' });
  const login = await h.call('POST', '/api/auth/login', { body: { username: 'ann', password: 'password-1' } });
  const token = login.sessionToken;

  const provision = await h.call('POST', '/api/mfa/enroll', { token });
  assert.equal(provision.status, 200);
  assert.match(provision.body.secret, /^[A-Z2-7]{16,}$/);
  assert.match(provision.body.otpauthUri, /^otpauth:\/\/totp\//);
  assert.match(provision.body.otpauthUri, /algorithm=SHA1/);
  assert.match(provision.body.otpauthUri, /digits=6/);

  // Provisioned is not enabled: a wrong confirmation code turns nothing on.
  const wrong = await h.call('POST', '/api/mfa/confirm', { token, body: { code: '000000' } });
  assert.equal(wrong.status, 403);
  let account = await h.call('GET', '/api/account', { token });
  assert.equal(account.body.account.mfaEnabled, false);

  const secret = base32Decode(provision.body.secret);
  const confirm = await h.call('POST', '/api/mfa/confirm', { token, body: { code: totpCode(secret, step()) } });
  assert.equal(confirm.status, 200);
  assert.equal(confirm.body.recoveryCodes.length, 10);
  assert.equal(new Set(confirm.body.recoveryCodes).size, 10);

  account = await h.call('GET', '/api/account', { token });
  assert.equal(account.body.account.mfaEnabled, true);
});

test('mfa login end to end: password alone yields no session, the code does', async (t) => {
  const h = await harness(t);
  h.auth.createUser({ username: 'ann', email: '', password: 'password-1', role: 'business' });
  const { secret } = await enroll(h, 'ann', 'password-1');

  const login = await h.call('POST', '/api/auth/login', { body: { username: 'ann', password: 'password-1' } });
  assert.equal(login.status, 200);
  assert.equal(login.body.mfaRequired, true);
  assert.ok(login.body.mfaToken);
  assert.equal(login.sessionToken, null, 'no session cookie before the second factor');
  assert.equal(h.auth.verify(login.body.mfaToken), null, 'the pending token is not a session');

  const bad = await h.call('POST', '/api/auth/mfa', { body: { mfaToken: login.body.mfaToken, code: '000000' } });
  assert.equal(bad.status, 401);

  const code = totpCode(secret, step() + 1);
  const done = await h.call('POST', '/api/auth/mfa', { body: { mfaToken: login.body.mfaToken, code } });
  assert.equal(done.status, 200);
  assert.equal(done.body.user.username, 'ann');
  assert.ok(done.sessionToken);
  const me = await h.call('GET', '/api/auth/me', { token: done.sessionToken });
  assert.equal(me.status, 200);

  // The pending token is single-use, and an accepted TOTP counter cannot be replayed.
  const replay = await h.call('POST', '/api/auth/mfa', { body: { mfaToken: login.body.mfaToken, code } });
  assert.equal(replay.status, 401);
  const again = await h.call('POST', '/api/auth/login', { body: { username: 'ann', password: 'password-1' } });
  const reuse = await h.call('POST', '/api/auth/mfa', { body: { mfaToken: again.body.mfaToken, code } });
  assert.equal(reuse.status, 401, 'a code already accepted this step is refused');
});

test('a wrong password reads the same whether or not the account has MFA', async (t) => {
  const h = await harness(t);
  h.auth.createUser({ username: 'plain', email: '', password: 'password-1', role: 'business' });
  h.auth.createUser({ username: 'guarded', email: '', password: 'password-1', role: 'business' });
  await enroll(h, 'guarded', 'password-1');

  const plain = await h.call('POST', '/api/auth/login', { body: { username: 'plain', password: 'nope-nope' } });
  const guarded = await h.call('POST', '/api/auth/login', { body: { username: 'guarded', password: 'nope-nope' } });
  assert.equal(plain.status, 401);
  assert.equal(guarded.status, 401);
  assert.deepEqual(guarded.body, plain.body, 'identical refusal, no MFA oracle');
});

test('wrong codes are throttled like wrong passwords', async (t) => {
  const h = await harness(t);
  h.auth.createUser({ username: 'ann', email: '', password: 'password-1', role: 'business' });
  await enroll(h, 'ann', 'password-1');

  const login = await h.call('POST', '/api/auth/login', { body: { username: 'ann', password: 'password-1' } });
  for (let i = 0; i < 5; i++) {
    const res = await h.call('POST', '/api/auth/mfa', { body: { mfaToken: login.body.mfaToken, code: '000000' } });
    assert.equal(res.status, 401, `attempt ${i + 1}`);
  }
  const locked = await h.call('POST', '/api/auth/mfa', { body: { mfaToken: login.body.mfaToken, code: '000000' } });
  assert.equal(locked.status, 429);
  assert.match(locked.body.error, /try again/i);
});

test('a recovery code signs in exactly once and regeneration invalidates the old set', async (t) => {
  const h = await harness(t);
  h.auth.createUser({ username: 'ann', email: '', password: 'password-1', role: 'business' });
  const { secret, recoveryCodes } = await enroll(h, 'ann', 'password-1');

  const login = await h.call('POST', '/api/auth/login', { body: { username: 'ann', password: 'password-1' } });
  const done = await h.call('POST', '/api/auth/mfa', {
    body: { mfaToken: login.body.mfaToken, code: recoveryCodes[0] },
  });
  assert.equal(done.status, 200);
  assert.ok(done.sessionToken);

  const again = await h.call('POST', '/api/auth/login', { body: { username: 'ann', password: 'password-1' } });
  const reused = await h.call('POST', '/api/auth/mfa', {
    body: { mfaToken: again.body.mfaToken, code: recoveryCodes[0] },
  });
  assert.equal(reused.status, 401, 'a consumed recovery code is gone');

  // Regeneration (proven by a current code) replaces the whole set.
  const regen = await h.call('POST', '/api/mfa/recovery-codes', {
    token: done.sessionToken,
    body: { code: totpCode(secret, step() + 1) },
  });
  assert.equal(regen.status, 200);
  assert.equal(regen.body.recoveryCodes.length, 10);
  const third = await h.call('POST', '/api/auth/login', { body: { username: 'ann', password: 'password-1' } });
  const oldCode = await h.call('POST', '/api/auth/mfa', {
    body: { mfaToken: third.body.mfaToken, code: recoveryCodes[1] },
  });
  assert.equal(oldCode.status, 401, 'the previous set no longer signs in');
  const newCode = await h.call('POST', '/api/auth/mfa', {
    body: { mfaToken: third.body.mfaToken, code: regen.body.recoveryCodes[0] },
  });
  assert.equal(newCode.status, 200);
});

test('users:manage may reset a lost second factor, and it broadcasts users.changed', async (t) => {
  const h = await harness(t);
  h.auth.createUser({ username: 'root', email: '', password: 'password-1', role: 'admin' });
  h.auth.createUser({ username: 'ann', email: '', password: 'password-1', role: 'business' });
  await enroll(h, 'ann', 'password-1');
  const admin = await h.call('POST', '/api/auth/login', { body: { username: 'root', password: 'password-1' } });

  h.broadcasts.length = 0;
  const reset = await h.call('DELETE', '/api/users/ann/mfa', { token: admin.sessionToken });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.user.mfaEnabled, false);
  assert.deepEqual(h.broadcasts, ['users.changed']);

  const login = await h.call('POST', '/api/auth/login', { body: { username: 'ann', password: 'password-1' } });
  assert.equal(login.status, 200);
  assert.ok(login.sessionToken, 'after the reset a plain password login works again');

  // And the reset is admin-only.
  const annReset = await h.call('DELETE', '/api/users/root/mfa', { token: login.sessionToken });
  assert.equal(annReset.status, 403);
});
