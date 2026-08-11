import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import migrations from '../dist/api/migrations.js';
import { OperateStore } from '../dist/api/operate-store.js';
import { Orchestrator } from '../dist/api/orchestrator.js';
import routeFactory from '../dist/api/routes.js';

// Keep runtime-owned files isolated so these tests see only seeded state.
process.env.COMPANION_HOME = mkdtempSync(join(tmpdir(), 'companion-lane-ownership-'));

const CONFIG = { host: '127.0.0.1', port: 8903, maxLiveRuns: 3 };

const ana = { username: 'ana', displayName: 'Ana', role: 'user' };
const bob = { username: 'bob', displayName: 'Bob', role: 'user' };

function seededStore() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  for (const m of migrations) m.up(db);
  return new OperateStore(db, {
    get: (key) => db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key)?.value ?? null,
    set: (key, value) => db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(key, value),
  });
}

/** Remote rows with no endpoint build no backend, so nothing opens a socket. */
function addMachine(store, id, name, ownerId = null) {
  store.runners.insert({
    id,
    name,
    kind: 'remote',
    endpoint: null,
    token: null,
    scope: 'shared',
    ownerId,
    maxRuns: 3,
    workspaceIds: [],
  });
}

/**
 * The lane routes over a real orchestrator + registry: ana owns a personal
 * machine, and a shared machine stands next to it so "may choose" and "may
 * not choose" answer differently for the same caller.
 */
function fixture() {
  const store = seededStore();
  addMachine(store, 'runner-ana', 'ana-laptop', 'ana');
  addMachine(store, 'runner-shared', 'build-box');
  const orchestrator = new Orchestrator(store, CONFIG, {}, null, () => {});
  const op = { orchestrator, runners: orchestrator.runners, runTaskDescriptors: () => [] };
  const routes = routeFactory({
    services: { get: (id) => (id === 'operate' ? op : {}) },
    rbac: { allows: () => true },
    modules: { list: () => [] },
  });
  const run = (method, path, params, body, user) => {
    const target = routes.find((c) => c.method === method && c.path === path);
    assert.ok(target, `${method} ${path} route exists`);
    return target.run(params, new URLSearchParams(), body, user, null, '127.0.0.1');
  };
  return { store, orchestrator, routes, run };
}

test("a lane may not name another user's private machine", async () => {
  const { orchestrator, run } = fixture();
  await assert.rejects(
    () => run('PUT', '/api/me/lane', {}, { runnerId: 'runner-ana', harness: null }, bob),
    (err) => err.status === 404,
  );
  // The refusal left no trace: bob still places automatically.
  assert.deepEqual(orchestrator.userLane('bob'), { runnerId: null, harness: null });
});

test('own, shared and auto stay choosable', async () => {
  const { orchestrator, run } = fixture();
  const own = await run('PUT', '/api/me/lane', {}, { runnerId: 'runner-ana', harness: null }, ana);
  assert.equal(own.lane.runnerId, 'runner-ana');
  assert.equal(orchestrator.userLane('ana').runnerId, 'runner-ana');
  await run('PUT', '/api/me/lane', {}, { runnerId: 'runner-shared', harness: null }, bob);
  assert.equal(orchestrator.userLane('bob').runnerId, 'runner-shared');
  await run('PUT', '/api/me/lane', {}, { runnerId: null, harness: null }, bob);
  assert.equal(orchestrator.userLane('bob').runnerId, null);
});

test('placement refuses a foreign personal machine even when a lane names it', async () => {
  const { orchestrator } = fixture();
  assert.equal(orchestrator.runners.refusalFor('runner-ana', { userId: 'ana' }), null);
  assert.notEqual(orchestrator.runners.refusalFor('runner-ana', { userId: 'bob' }), null);
  // Defense in depth behind the route check: a stored or captured lane must
  // not execute on somebody else's machine either.
  await assert.rejects(
    () =>
      orchestrator.createRun({
        kind: 'analysis',
        userId: 'bob',
        lane: { runnerId: 'runner-ana', harness: null },
      }),
    /Change where your runs go/,
  );
});

test('the under-gated lane model route is gone', () => {
  const { routes } = fixture();
  assert.equal(routes.find((c) => c.path === '/api/me/lane/model'), undefined);
});
