import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import migrations from '../dist/api/migrations.js';
import { WorkspacesStore } from '../dist/api/workspaces-store.js';
import routeFactory from '../dist/api/routes.js';

const ana = { username: 'ana', displayName: 'Ana', role: 'user' };

/**
 * The create route over a real store and schema. `staleList` empties the slug
 * snapshot the handler reads, standing in for two concurrent creates that both
 * read `taken` before either row lands: the second insert then collides at the
 * UNIQUE constraint itself.
 */
function fixture({ staleList = false } = {}) {
  const db = new Database(':memory:');
  for (const m of migrations) m.up(db);
  db.exec(`CREATE TABLE users (username TEXT PRIMARY KEY, display_name TEXT)`);
  const workspaces = new WorkspacesStore(db);
  workspaces.ensureDefault();
  if (staleList) workspaces.list = () => [];
  const services = { workspace: workspaces, core: {}, notifications: {}, reports: {} };
  const routes = routeFactory({
    services: { get: (id) => services[id], tryGet: () => undefined },
    rbac: { allows: () => true },
    broadcast: () => {},
    bus: { emit: () => {}, on: () => () => {} },
  });
  const run = (method, path, params, body, user) => {
    const target = routes.find((c) => c.method === method && c.path === path);
    assert.ok(target, `${method} ${path} route exists`);
    return target.run(params, new URLSearchParams(), body ?? {}, user, null, '127.0.0.1');
  };
  return { db, workspaces, run };
}

test('a colliding name gets a suffixed slug instead of a refusal', async () => {
  const fx = fixture();
  const first = await fx.run('POST', '/api/workspaces', {}, { name: 'Alpha' }, ana);
  const second = await fx.run('POST', '/api/workspaces', {}, { name: 'Alpha' }, ana);
  assert.equal(first.body.workspace.slug, 'alpha');
  assert.match(second.body.workspace.slug, /^alpha-/);
});

test('a slug collision at the constraint answers 400, not a raw 500', async () => {
  const fx = fixture({ staleList: true });
  await fx.run('POST', '/api/workspaces', {}, { name: 'Alpha' }, ana);
  await assert.rejects(
    () => fx.run('POST', '/api/workspaces', {}, { name: 'Alpha' }, ana),
    (err) => err.status === 400 && /name/i.test(err.message),
  );
});
