import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import migrations from '../dist/api/migrations.js';
import { ApiTokensStore } from '../dist/api/api-tokens-store.js';
import { Auth } from '../dist/api/auth.js';
import { SessionsStore } from '../dist/api/sessions-store.js';
import { SettingsStore } from '../dist/api/settings-store.js';
import { UsersStore } from '../dist/api/users-store.js';

function harness() {
  const db = new Database(':memory:');
  for (const migration of migrations) migration.up(db);
  const sessions = new SessionsStore(db);
  const tokens = new ApiTokensStore(db);
  const users = new UsersStore(db, sessions);
  const permissions = ['widgets:read', 'widgets:manage', 'tokens:manage', 'tokens:admin'];
  const rbac = {
    has: (_role, permission) => permissions.includes(permission),
    allows: (user, permission) =>
      permissions.includes(permission)
      && (user.permissionScope === undefined || user.permissionScope.includes(permission)),
    permissionsFor: () => [...permissions],
    catalog: () => permissions.map((id) => ({ id, title: id, owner: 'probe', implies: [] })),
    roles: () => ['admin'],
    hasRole: (role) => role === 'admin',
    baseline: () => [...permissions],
    explain: () => { throw new Error('unused'); },
  };
  const auth = new Auth(users, sessions, tokens, new SettingsStore(db), rbac, {});
  auth.seedFromEnv([{ username: 'admin', email: '', password: 'password', role: 'admin' }]);
  return { auth, db, tokens };
}

test('managed API tokens are hashed, scoped, and revocable', () => {
  const { auth, db, tokens } = harness();
  const user = { username: 'admin', displayName: 'Admin', role: 'admin' };

  assert.deepEqual(
    auth.apiTokenCapabilities(user).map((item) => item.id),
    ['widgets:manage', 'widgets:read'],
  );
  assert.throws(
    () => auth.createApiToken(user, { name: 'Escalation', permissions: ['tokens:manage'], expiresInDays: 7 }),
    /cannot delegate tokens:manage/,
  );
  const created = auth.createApiToken(user, {
    name: 'Probe',
    permissions: ['widgets:read', 'widgets:read'],
    expiresInDays: 7,
  });
  assert.match(created.token, /^cmp_/);
  assert.deepEqual(created.record.permissions, ['widgets:read']);

  const stored = db.prepare(`SELECT token_hash, permissions FROM api_tokens WHERE id = ?`).get(created.record.id);
  assert.notEqual(stored.token_hash, created.token);
  assert.equal(stored.token_hash.length, 64);
  assert.equal(stored.permissions, '["widgets:read"]');

  const verified = auth.verify(created.token);
  assert.deepEqual(verified.permissionScope, ['widgets:read']);
  assert.equal(auth.require(verified, 'widgets:read').username, 'admin');
  assert.throws(() => auth.require(verified, 'widgets:manage'), /requires widgets:manage/);
  assert.notEqual(tokens.get(created.record.id).lastUsedAt, null);

  assert.equal(auth.revokeOwnApiToken('someone-else', created.record.id), null);
  assert.equal(auth.revokeOwnApiToken('admin', created.record.id).id, created.record.id);
  assert.equal(auth.verify(created.token), null);
  db.close();
});

test('password changes and expiry invalidate managed API tokens', () => {
  const first = harness();
  const user = { username: 'admin', displayName: 'Admin', role: 'admin' };
  const passwordToken = first.auth.createApiToken(user, {
    name: 'Password-bound',
    permissions: ['widgets:read'],
    expiresInDays: 7,
  });

  first.auth.updateOwnAccount('admin', { currentPassword: 'password', newPassword: 'new-password' });
  assert.equal(first.auth.verify(passwordToken.token), null);
  assert.deepEqual(first.auth.listApiTokens('admin'), []);
  first.db.close();

  const second = harness();
  const expired = second.auth.createApiToken(user, {
    name: 'Expired',
    permissions: ['widgets:read'],
    expiresInDays: 7,
  });
  second.db.prepare(`UPDATE api_tokens SET expires_at = ? WHERE id = ?`).run(Date.now() - 1, expired.record.id);
  assert.equal(second.auth.verify(expired.token), null);
  assert.equal(second.tokens.get(expired.record.id), null);
  second.db.close();
});

test('a malformed persisted scope fails closed', () => {
  const { db, tokens } = harness();
  db.prepare(
    `INSERT INTO api_tokens (id, token_hash, username, name, permissions, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('tok-corrupt', 'hash', 'admin', 'Corrupt', '{nope', Date.now(), Date.now() + 60_000);

  assert.deepEqual(tokens.getByHash('hash').permissions, []);
  db.close();
});
