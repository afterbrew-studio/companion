import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import migrations from '../dist/api/migrations.js';
import { AuditStore } from '../dist/api/audit-store.js';

const upTo = (version) => {
  const db = new Database(':memory:');
  for (const m of migrations.filter((x) => x.version <= version)) m.up(db);
  return db;
};

test('a public route has no actor, and recording one must not be dropped', () => {
  const db = upTo(Infinity);
  const store = new AuditStore(db);

  // The event the trail exists for: someone tried to sign in and was refused.
  store.record({
    at: Date.now(),
    actor: null,
    action: 'POST /api/auth/login',
    access: 'public',
    status: 401,
    module: 'core',
  });

  const [row] = store.list({ limit: 10 });
  assert.equal(row.actor, null);
  assert.equal(row.status, 401);
});

test('an authenticated event still records its actor', () => {
  const db = upTo(Infinity);
  const store = new AuditStore(db);
  store.record({
    at: Date.now(),
    actor: 'admin',
    action: 'POST /api/roles',
    access: 'users:manage',
    status: 201,
    module: 'core',
  });

  const [row] = store.list({ limit: 10 });
  assert.equal(row.actor, 'admin');
});

test('upgrading an instance that already has audit rows keeps every one of them', () => {
  // Exactly the shipped shape: v1..v3, with the NOT NULL actor that caused
  // this. Seeded with raw SQL matching that era's columns; the current store
  // targets the head schema and never runs against v3.
  const db = upTo(3);
  const seed = db.prepare(
    `INSERT INTO audit_log (at, actor, action, access, status, module, detail) VALUES (?, ?, ?, ?, ?, ?, NULL)`,
  );
  seed.run(1, 'admin', 'POST /api/roles', 'users:manage', 201, 'core');
  seed.run(2, 'bob', 'POST /api/modules/:id/disable', 'modules:manage', 403, 'core');

  migrations.find((m) => m.version === 4).up(db);

  const rows = db.prepare(`SELECT actor, action, status FROM audit_log ORDER BY id`).all();
  assert.equal(rows.length, 2, 'a rebuild that loses history is worse than the bug');
  assert.deepEqual(rows.map((r) => r.actor), ['admin', 'bob']);
  assert.equal(rows[1].status, 403, 'refusals are the rows an auditor asks for');
});

test('the migration is idempotent, so a resumed upgrade is safe', () => {
  const db = upTo(4);
  const v4 = migrations.find((m) => m.version === 4);
  assert.doesNotThrow(() => v4.up(db));
  const cols = db.prepare(`PRAGMA table_info(audit_log)`).all();
  assert.equal(cols.find((c) => c.name === 'actor').notnull, 0);
  assert.equal(cols.filter((c) => c.name === 'actor').length, 1);
});

test('the indexes survive the rebuild, or deep paging scans the table', () => {
  const db = upTo(4);
  const names = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'audit_log'`)
    .all()
    .map((r) => r.name);
  assert.ok(names.includes('idx_audit_at'));
  assert.ok(names.includes('idx_audit_actor'));
});
