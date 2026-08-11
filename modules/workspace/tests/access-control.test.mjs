import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import migrations from '../dist/api/migrations.js';
import { WorkspacesStore } from '../dist/api/workspaces-store.js';
import { NotificationsStore } from '../dist/api/notifications-store.js';
import { NotificationsService } from '../dist/api/notifications-service.js';
import routeFactory from '../dist/api/routes.js';

const ana = { username: 'ana', displayName: 'Ana', role: 'user' };
const bob = { username: 'bob', displayName: 'Bob', role: 'user' };
const root = { username: 'root', displayName: 'Root', role: 'admin' };

/**
 * Routes over a real store and schema, like the workspace-delete fixture.
 * `rbac.allows` answers true for everyone on purpose: the predicates under test
 * must hold the workspace boundary even when every platform permission is
 * granted. `withRepos` publishes a stand-in for code's v_repos view; leaving it
 * out simulates module-code uninstalled.
 */
function fixture({ withRepos = true } = {}) {
  const db = new Database(':memory:');
  for (const m of migrations) m.up(db);
  db.exec(`CREATE TABLE users (username TEXT PRIMARY KEY, display_name TEXT)`);
  if (withRepos) {
    db.exec(`CREATE TABLE v_repos (full_name TEXT NOT NULL, workspace_id TEXT NOT NULL)`);
    db.exec(`INSERT INTO v_repos VALUES ('acme/site', 'ws-default'), ('acme/secret', 'ws-2')`);
  }
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
  const notificationsStore = new NotificationsStore(db);
  const notifications = new NotificationsService(notificationsStore, () => {});
  const services = { workspace: workspaces, core: {}, notifications, reports: {} };
  const routes = routeFactory({
    services: { get: (id) => services[id], tryGet: () => undefined },
    rbac: { allows: () => true },
    broadcast: () => {},
  });
  const run = (method, path, params, body, user, query) => {
    const target = routes.find((c) => c.method === method && c.path === path);
    assert.ok(target, `${method} ${path} route exists`);
    return target.run(params, query ?? new URLSearchParams(), body ?? {}, user, null, '127.0.0.1');
  };
  return { db, workspaces, notifications, run };
}

test('canAccess: public is open, private is members-only regardless of platform role', () => {
  const fx = fixture();
  const pub = fx.workspaces.get('ws-default');
  const priv = fx.workspaces.get('ws-2');
  assert.equal(fx.workspaces.canAccess(bob, pub), true);
  assert.equal(fx.workspaces.canAccess(ana, priv), true);
  assert.equal(fx.workspaces.canAccess(bob, priv), false);
  // An admin is still outside a private workspace they were never invited to.
  assert.equal(fx.workspaces.canAccess(root, priv), false);
});

test('canAccessWorkspace falls closed on unknown ids', () => {
  const fx = fixture();
  assert.equal(fx.workspaces.canAccessWorkspace(ana, 'ws-2'), true);
  assert.equal(fx.workspaces.canAccessWorkspace(bob, 'ws-2'), false);
  assert.equal(fx.workspaces.canAccessWorkspace(root, 'ws-missing'), false);
});

test('requireAccessible answers the same 404 for private, unknown, and anonymous', () => {
  const fx = fixture();
  assert.equal(fx.workspaces.requireAccessible(ana, 'ws-2').id, 'ws-2');
  const is404 = (err) => err.status === 404;
  assert.throws(() => fx.workspaces.requireAccessible(bob, 'ws-2'), is404);
  assert.throws(() => fx.workspaces.requireAccessible(root, 'ws-2'), is404);
  assert.throws(() => fx.workspaces.requireAccessible(bob, 'ws-missing'), is404);
  assert.throws(() => fx.workspaces.requireAccessible(null, 'ws-2'), is404);
});

test('GET /api/workspaces lists only what the caller can access', async () => {
  const fx = fixture();
  const mine = await fx.run('GET', '/api/workspaces', {}, undefined, ana);
  assert.deepEqual(mine.workspaces.map((w) => w.id).sort(), ['ws-2', 'ws-default']);
  const theirs = await fx.run('GET', '/api/workspaces', {}, undefined, bob);
  assert.deepEqual(theirs.workspaces.map((w) => w.id), ['ws-default']);
});

test('the members listing of a private workspace does not leak to non-members', async () => {
  const fx = fixture();
  const { members } = await fx.run('GET', '/api/workspaces/:id/members', { id: 'ws-2' }, undefined, ana);
  assert.ok(members.some((m) => m.username === 'ana' && m.role === 'owner'));
  // Even with every platform permission granted, a non-member admin reads 404.
  await assert.rejects(
    () => fx.run('GET', '/api/workspaces/:id/members', { id: 'ws-2' }, undefined, root),
    (err) => err.status === 404,
  );
});

test('canAccessRepo follows the workspace access rule of the mapped repo', () => {
  const fx = fixture();
  assert.equal(fx.workspaces.canAccessRepo(bob, 'acme/site'), true);
  assert.equal(fx.workspaces.canAccessRepo(ana, 'acme/secret'), true);
  assert.equal(fx.workspaces.canAccessRepo(bob, 'acme/secret'), false);
  assert.equal(fx.workspaces.canAccessRepo(root, 'acme/secret'), false);
});

test('canAccessRepo fails closed without a workspace mapping', () => {
  const fx = fixture();
  assert.equal(fx.workspaces.canAccessRepo(root, 'acme/orphan'), false);
  // module-code uninstalled: the v_repos view is gone, so no repo has a scope.
  const bare = fixture({ withRepos: false });
  assert.equal(bare.workspaces.canAccessRepo(root, 'acme/site'), false);
});

test('an addressed notification stays invisible to every other viewer', () => {
  const fx = fixture();
  fx.notifications.emit({ workspaceId: null, kind: 'info', title: 'broadcast' });
  fx.notifications.emit({ workspaceId: null, kind: 'info', title: 'for ana', userId: 'ana' });
  const anaSees = fx.notifications.list(null, 100, undefined, 'ana').map((n) => n.title);
  assert.deepEqual(anaSees.sort(), ['broadcast', 'for ana']);
  const bobSees = fx.notifications.list(null, 100, undefined, 'bob').map((n) => n.title);
  assert.deepEqual(bobSees, ['broadcast']);
  const addressed = fx.notifications.list(null, 100, undefined, 'ana').find((n) => n.userId === 'ana');
  assert.equal(fx.notifications.get(addressed.id, 'bob'), undefined);
  // Nor can another viewer spend it: marking leaves no receipt for bob.
  fx.notifications.markRead(addressed.id, 'bob');
  assert.equal(fx.notifications.get(addressed.id, 'ana').readAt, null);
});

test('GET /api/notifications scopes rows to the workspaces the viewer can see', async () => {
  const fx = fixture();
  fx.notifications.emit({ workspaceId: null, kind: 'info', title: 'instance-wide' });
  fx.notifications.emit({ workspaceId: 'ws-2', kind: 'info', title: 'private business' });
  const mine = await fx.run('GET', '/api/notifications', {}, undefined, ana);
  assert.deepEqual(mine.notifications.map((n) => n.title).sort(), ['instance-wide', 'private business']);
  const theirs = await fx.run('GET', '/api/notifications', {}, undefined, bob);
  assert.deepEqual(theirs.notifications.map((n) => n.title), ['instance-wide']);
  // Naming the private workspace does not widen the scope for a non-member.
  const forced = await fx.run(
    'GET',
    '/api/notifications',
    {},
    undefined,
    bob,
    new URLSearchParams({ workspace: 'ws-2' }),
  );
  assert.deepEqual(forced.notifications.map((n) => n.title), ['instance-wide']);
});

test('legacy NULL-repo notification rows fail closed', () => {
  const fx = fixture();
  fx.db
    .prepare(
      `INSERT INTO notifications (id, workspace_id, repo, kind, title, body, created_at)
       VALUES ('n-legacy', NULL, NULL, 'info', 'pre-scoping row', '', ?)`,
    )
    .run(Date.now());
  assert.deepEqual(fx.notifications.list(null, 100, undefined, 'ana'), []);
});
