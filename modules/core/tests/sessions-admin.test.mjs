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

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };
const MINUTE = 60_000;

const rbacStub = {
  has: () => true,
  allows: (user, permission) => user?.role === 'admin' || permission !== 'users:manage',
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

async function harness(t, { idleTimeoutMs = () => 0 } = {}) {
  const db = new Database(':memory:');
  for (const migration of migrations) migration.up(db);
  const sessions = new SessionsStore(db);
  const users = new UsersStore(db, sessions);
  const settings = new SettingsStore(db);
  const roles = new RolesService(new RolesStore(db), users, rbacStub, () => {}, { record() {} }, noopLog);
  const mfa = new Mfa(memorySecrets(), new MfaStore(db), users);
  const auth = new Auth(users, sessions, new ApiTokensStore(db), settings, rbacStub, roles, mfa, idleTimeoutMs);

  const ctx = {
    config: { publicUrl: undefined, authMode: 'password', host: '127.0.0.1', github: { host: 'github.com' } },
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

  const call = async (method, path, { token, body } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
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

  const signIn = async (username, password) => {
    const res = await call('POST', '/api/auth/login', { body: { username, password } });
    assert.equal(res.status, 200);
    return res.sessionToken;
  };

  return { call, signIn, auth, db };
}

test('the migration backfills a public id onto pre-existing sessions', () => {
  const db = new Database(':memory:');
  for (const migration of migrations) {
    if (migration.version >= 10) break;
    migration.up(db);
  }
  db.prepare(
    `INSERT INTO sessions (token_hash, username, role, access, created_at, expires_at) VALUES (?, ?, ?, 'full', ?, ?)`,
  ).run('legacy-hash', 'ann', 'business', Date.now(), Date.now() + MINUTE);

  for (const migration of migrations) {
    if (migration.version >= 10) migration.up(db);
  }

  const row = db.prepare(`SELECT id, last_seen_at FROM sessions WHERE token_hash = 'legacy-hash'`).get();
  assert.match(row.id, /^ses-[0-9a-f]{12}$/);
  assert.equal(row.last_seen_at, null);
  db.close();
});

test('verify stamps last_seen_at at most once a minute', async (t) => {
  const h = await harness(t);
  h.auth.createUser({ username: 'ann', email: '', password: 'password-1', role: 'business' });
  const token = await h.signIn('ann', 'password-1');

  // Fresh session: creation counts as activity, so no write yet.
  assert.ok(h.auth.verify(token));
  assert.equal(h.db.prepare(`SELECT last_seen_at FROM sessions`).get().last_seen_at, null);

  const before = Date.now();
  h.db.prepare(`UPDATE sessions SET last_seen_at = ?`).run(before - 2 * MINUTE);
  assert.ok(h.auth.verify(token));
  const stamped = h.db.prepare(`SELECT last_seen_at FROM sessions`).get().last_seen_at;
  assert.ok(stamped >= before, 'stale activity is re-stamped');

  assert.ok(h.auth.verify(token));
  assert.equal(
    h.db.prepare(`SELECT last_seen_at FROM sessions`).get().last_seen_at,
    stamped,
    'a second verify within the minute writes nothing',
  );
});

test('sessions idle beyond the configured bound are rejected and deleted', async (t) => {
  const h = await harness(t, { idleTimeoutMs: () => 30 * MINUTE });
  h.auth.createUser({ username: 'ann', email: '', password: 'password-1', role: 'business' });
  const token = await h.signIn('ann', 'password-1');

  h.db.prepare(`UPDATE sessions SET last_seen_at = ?`).run(Date.now() - 29 * MINUTE);
  assert.ok(h.auth.verify(token), 'within the bound the session lives');

  h.db.prepare(`UPDATE sessions SET last_seen_at = ?`).run(Date.now() - 31 * MINUTE);
  assert.equal(h.auth.verify(token), null, 'idle beyond the bound is signed out');
  assert.equal(h.db.prepare(`SELECT COUNT(*) AS n FROM sessions`).get().n, 0, 'the row is gone');

  // A never-used session measures idleness from creation.
  const second = await h.signIn('ann', 'password-1');
  h.db.prepare(`UPDATE sessions SET created_at = ?`).run(Date.now() - 31 * MINUTE);
  assert.equal(h.auth.verify(second), null);
});

test('idle timeout 0 (the default) disables the idle bound', async (t) => {
  const h = await harness(t);
  h.auth.createUser({ username: 'ann', email: '', password: 'password-1', role: 'business' });
  const token = await h.signIn('ann', 'password-1');
  h.db.prepare(`UPDATE sessions SET last_seen_at = ?`).run(Date.now() - 6 * 24 * 60 * MINUTE);
  assert.ok(h.auth.verify(token), 'only the absolute 7-day lifetime applies');
});

test('self-service: list flags the current session, revoke ends one, revoking the current logs out', async (t) => {
  const h = await harness(t);
  h.auth.createUser({ username: 'ann', email: '', password: 'password-1', role: 'business' });
  const first = await h.signIn('ann', 'password-1');
  const second = await h.signIn('ann', 'password-1');

  const list = await h.call('GET', '/api/me/sessions', { token: second });
  assert.equal(list.status, 200);
  assert.equal(list.body.sessions.length, 2);
  const current = list.body.sessions.filter((s) => s.current);
  assert.equal(current.length, 1);
  for (const s of list.body.sessions) {
    assert.match(s.id, /^ses-/);
    assert.equal(typeof s.createdAt, 'number');
    assert.equal(typeof s.expiresAt, 'number');
    assert.equal(s.access, 'full');
  }

  const other = list.body.sessions.find((s) => !s.current);
  const revoke = await h.call('DELETE', `/api/me/sessions/${other.id}`, { token: second });
  assert.equal(revoke.status, 200);
  assert.equal(h.auth.verify(first), null, 'the revoked session is dead');

  const revokeCurrent = await h.call('DELETE', `/api/me/sessions/${current[0].id}`, { token: second });
  assert.equal(revokeCurrent.status, 200, 'revoking your own current session is allowed');
  assert.equal(h.auth.verify(second), null, 'and it logs you out');
});

test('a session id belonging to someone else is not yours to revoke', async (t) => {
  const h = await harness(t);
  h.auth.createUser({ username: 'ann', email: '', password: 'password-1', role: 'business' });
  h.auth.createUser({ username: 'bob', email: '', password: 'password-1', role: 'business' });
  const ann = await h.signIn('ann', 'password-1');
  const bob = await h.signIn('bob', 'password-1');

  const bobSessions = await h.call('GET', '/api/me/sessions', { token: bob });
  const res = await h.call('DELETE', `/api/me/sessions/${bobSessions.body.sessions[0].id}`, { token: ann });
  assert.equal(res.status, 404, 'indistinguishable from a session that never existed');
  assert.ok(h.auth.verify(bob), "bob's session survives");
});

test('admin: users:manage lists and revokes everything for a user; business may not', async (t) => {
  const h = await harness(t);
  h.auth.createUser({ username: 'root', email: '', password: 'password-1', role: 'admin' });
  h.auth.createUser({ username: 'ann', email: '', password: 'password-1', role: 'business' });
  const root = await h.signIn('root', 'password-1');
  const ann = await h.signIn('ann', 'password-1');
  await h.signIn('ann', 'password-1');

  const denied = await h.call('GET', '/api/users/root/sessions', { token: ann });
  assert.equal(denied.status, 403);

  const list = await h.call('GET', '/api/users/ann/sessions', { token: root });
  assert.equal(list.status, 200);
  assert.equal(list.body.sessions.length, 2);
  assert.equal(list.body.sessions.some((s) => s.current), false);

  const revoke = await h.call('DELETE', '/api/users/ann/sessions', { token: root });
  assert.equal(revoke.status, 200);
  assert.equal(revoke.body.revoked, 2);
  assert.equal(h.auth.verify(ann), null, "ann's next request is a 401");
  assert.ok(h.auth.verify(root), 'the admin keeps their own session');
});
