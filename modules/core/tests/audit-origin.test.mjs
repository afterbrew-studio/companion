import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import migrations from '../dist/api/migrations.js';
import { AuditStore } from '../dist/api/audit-store.js';

function freshStore() {
  const db = new Database(':memory:');
  for (const m of migrations) m.up(db);
  return new AuditStore(db);
}

test('audit rows carry the request origin and read it back', () => {
  const store = freshStore();
  store.record({
    at: 1,
    actor: 'alice',
    action: 'POST /api/auth/login',
    access: 'public',
    status: 200,
    module: 'core',
    ip: '203.0.113.7',
    agent: 'probe/1.0',
  });
  const [row] = store.list();
  assert.equal(row.actor, 'alice');
  assert.equal(row.ip, '203.0.113.7');
  assert.equal(row.agent, 'probe/1.0');
});

test('events emitted outside a request store null origin columns', () => {
  const store = freshStore();
  store.record({
    at: 2,
    actor: 'root',
    action: 'job core.cli-token.remint',
    access: 'system',
    status: 200,
    module: 'core',
  });
  const [row] = store.list();
  assert.equal(row.ip, null);
  assert.equal(row.agent, null);
});

test('the origin migration is idempotent on a database that already has it', () => {
  const db = new Database(':memory:');
  for (const m of migrations) m.up(db);
  const origin = migrations.find((m) => m.name === 'audit_request_origin');
  origin.up(db);
  new AuditStore(db).record({
    at: 3,
    actor: null,
    action: 'POST /hook',
    access: 'raw',
    status: 401,
    module: 'automations',
    ip: '127.0.0.1',
  });
  assert.equal(new AuditStore(db).list().length, 1);
});
