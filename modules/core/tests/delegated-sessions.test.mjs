import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import migrations from '../dist/api/migrations.js';
import { SessionsStore } from '../dist/api/sessions-store.js';

test('existing sessions migrate as full access while delegated access persists', () => {
  const db = new Database(':memory:');
  for (const migration of migrations.filter((item) => item.version < 5)) migration.up(db);
  db.prepare(
    `INSERT INTO sessions (token_hash, username, role, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
  ).run('legacy', 'admin', 'admin', 1, Date.now() + 60_000);

  const delegated = migrations.find((item) => item.version === 5);
  delegated.up(db);
  delegated.up(db);
  const sessions = new SessionsStore(db);
  sessions.insert({
    tokenHash: 'assistant',
    username: 'maintainer',
    role: 'maintainer',
    access: 'read-only',
    createdAt: 2,
    expiresAt: Date.now() + 60_000,
  });
  db.prepare(`INSERT INTO sessions (token_hash, username, role, access, created_at, expires_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run('malformed', 'maintainer', 'maintainer', 'unexpected', 3, Date.now() + 60_000);

  assert.equal(sessions.get('legacy').access, 'full');
  assert.equal(sessions.get('assistant').access, 'read-only');
  assert.equal(sessions.get('malformed').access, 'read-only');
  db.close();
});
