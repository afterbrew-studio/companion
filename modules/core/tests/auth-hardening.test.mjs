import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const users = new UsersStore(db, sessions);
  const rbac = {
    has: () => true,
    allows: () => true,
    permissionsFor: () => ['users:manage'],
    catalog: () => [],
    roles: () => ['admin'],
    hasRole: (role) => role === 'admin',
    baseline: () => ['users:manage'],
    explain: () => { throw new Error('unused'); },
  };
  const auth = new Auth(users, sessions, new ApiTokensStore(db), new SettingsStore(db), rbac, {});
  return { auth, db, users };
}

test('first admin requires the owner-only one-time bootstrap capability', () => {
  const { auth, db } = harness();
  const dir = mkdtempSync(join(tmpdir(), 'companion-bootstrap-'));
  const file = join(dir, 'bootstrap-token');
  try {
    assert.equal(auth.prepareBootstrap(null, file), 'file');
    const token = readFileSync(file, 'utf8').trim();
    assert.ok(token.length >= 32);
    assert.throws(() => auth.setup('admin', 'admin@example.test', 'password123', 'x'.repeat(32)), /invalid bootstrap/);
    const session = auth.setup('admin', 'admin@example.test', 'password123', token);
    assert.equal(session.user.role, 'admin');
    assert.equal(existsSync(file), false);
    assert.throws(() => auth.setup('second', 'second@example.test', 'password123', token), /already completed/);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('login throttles a normalized identity and reports retry guidance', () => {
  const { auth, db } = harness();
  auth.seedFromEnv([{ username: 'admin', email: '', password: 'password123', role: 'admin' }]);
  for (let i = 0; i < 5; i++) {
    assert.throws(() => auth.login(i % 2 ? 'ADMIN' : 'admin', 'wrong', '203.0.113.4'), /invalid username or password/);
  }
  assert.throws(
    () => auth.login('admin', 'wrong', '203.0.113.4'),
    (error) => error.status === 429 && error.retryAfter > 0,
  );
  db.close();
});

test('successful login upgrades the legacy scrypt profile', () => {
  const { auth, db, users } = harness();
  const salt = randomBytes(16);
  const legacy = `s2$${salt.toString('base64url')}$${scryptSync('password123', salt, 32).toString('base64url')}`;
  users.insert({ username: 'admin', email: '', passwordHash: legacy, role: 'admin' });

  auth.login('admin', 'password123', '127.0.0.1');
  assert.match(users.get('admin').passwordHash, /^s3\$32768\$8\$3\$/);
  db.close();
});
