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
  const users = new UsersStore(db, sessions);
  const settings = new SettingsStore(db);
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
  const auth = new Auth(users, sessions, new ApiTokensStore(db), settings, rbac, {});
  return { auth, db, settings };
}

test('trusted local mode creates a real admin and mints an ordinary session', () => {
  const { auth, db, settings } = harness();
  settings.set('auth.localSeedPassword', 'legacy-cleartext');

  assert.equal(auth.seedLocalAdmin(), 'admin');
  assert.equal(auth.setupNeeded(), false);
  assert.equal(settings.get('auth.localSeedPassword'), null);

  const session = auth.localSession();
  assert.equal(session.user.username, 'admin');
  assert.equal(session.user.role, 'admin');
  assert.equal(auth.verify(session.token)?.username, 'admin');
  assert.equal(auth.seedLocalAdmin(), null);
  db.close();
});
