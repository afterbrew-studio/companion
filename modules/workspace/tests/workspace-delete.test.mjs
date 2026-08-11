import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import migrations from '../dist/api/migrations.js';
import { WorkspacesStore } from '../dist/api/workspaces-store.js';
import routeFactory from '../dist/api/routes.js';

const ana = { username: 'ana', displayName: 'Ana', role: 'user' };
const admin = { username: 'root', displayName: 'Root', role: 'admin' };

/**
 * The workspace routes over a real store and schema. `code` is what
 * `ctx.services.tryGet('code')` answers: undefined simulates module-code
 * absent or disabled, exactly what the route sees then.
 */
function fixture({ code } = {}) {
  const db = new Database(':memory:');
  for (const m of migrations) m.up(db);
  // Core-owned table the member listing LEFT JOINs for display names.
  db.exec(`CREATE TABLE users (username TEXT PRIMARY KEY, display_name TEXT)`);
  const workspaces = new WorkspacesStore(db);
  workspaces.ensureDefault();
  workspaces.insert({
    id: 'ws-2',
    name: 'Second',
    slug: 'second',
    description: '',
    visibility: 'private',
    ownerId: 'ana',
  });
  const services = { workspace: workspaces, core: {}, notifications: {}, reports: {} };
  const routes = routeFactory({
    services: { get: (id) => services[id], tryGet: (id) => (id === 'code' ? code : undefined) },
    rbac: { allows: () => true },
    broadcast: () => {},
  });
  const run = (method, path, params, body, user) => {
    const target = routes.find((c) => c.method === method && c.path === path);
    assert.ok(target, `${method} ${path} route exists`);
    return target.run(params, new URLSearchParams(), body ?? {}, user, null, '127.0.0.1');
  };
  return { db, workspaces, run };
}

test('deleting a workspace succeeds when module-code is absent', async () => {
  const fx = fixture();
  const result = await fx.run('DELETE', '/api/workspaces/:id', { id: 'ws-2' }, undefined, ana);
  assert.deepEqual(result, { ok: true });
  assert.equal(fx.workspaces.get('ws-2'), undefined);
  assert.equal(fx.workspaces.members('ws-2').length, 0);
});

test("code's pipeline cleanup runs when the module is present", async () => {
  const cleaned = [];
  const fx = fixture({ code: { pipelines: { removeForWorkspace: (id) => cleaned.push(id) } } });
  await fx.run('DELETE', '/api/workspaces/:id', { id: 'ws-2' }, undefined, ana);
  assert.deepEqual(cleaned, ['ws-2']);
});

test('removing the owner answers 400 instead of a silent no-op', async () => {
  const fx = fixture();
  fx.workspaces.addMember('ws-2', 'bob');
  // Membership is its own gate: even an admin manages only from inside.
  fx.workspaces.addMember('ws-2', 'root');
  await assert.rejects(
    () => fx.run('DELETE', '/api/workspaces/:id/members/:username', { id: 'ws-2', username: 'ana' }, undefined, admin),
    (err) => err.status === 400,
  );
  assert.ok(fx.workspaces.members('ws-2').some((m) => m.username === 'ana' && m.role === 'owner'));
  // A regular member still leaves normally.
  const { members } = await fx.run(
    'DELETE',
    '/api/workspaces/:id/members/:username',
    { id: 'ws-2', username: 'bob' },
    undefined,
    admin,
  );
  assert.ok(!members.some((m) => m.username === 'bob'));
});
