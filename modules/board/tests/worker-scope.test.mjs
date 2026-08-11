import assert from 'node:assert/strict';
import test from 'node:test';
import routeFactory from '../dist/api/routes.js';
import { fixture, insertDeveloper } from './fixture.mjs';

const member = { username: 'ana', displayName: 'Ana', role: 'user' };
const outsider = { username: 'mallory', displayName: 'Mallory', role: 'user' };

/**
 * The board routes over the service fixture, with workspace access answered
 * per user: ws-1 is reachable by everyone but mallory. Inaccessible reads as
 * not-found (the house convention), so existence is never leaked.
 */
function routesFixture() {
  const canAccess = (user, workspaceId) => workspaceId === 'ws-1' && user.username !== 'mallory';
  const fx = fixture({ canAccessWorkspace: canAccess });
  insertDeveloper(fx.store);
  const board = fx.makeService();
  const workspace = {
    canAccessWorkspace: canAccess,
    requireAccessible: (user, workspaceId) => {
      if (!user || !canAccess(user, workspaceId)) {
        throw Object.assign(new Error(`workspace ${workspaceId} not found`), { status: 404 });
      }
      return { id: workspaceId };
    },
  };
  const services = { board, workspace, code: { repos: { inWorkspace: () => true } } };
  const routes = routeFactory({ services: { get: (id) => services[id] } });
  const run = (method, path, params, body, user) => {
    const target = routes.find((c) => c.method === method && c.path === path);
    assert.ok(target, `${method} ${path} route exists`);
    return target.run(params, new URLSearchParams(), body ?? {}, user, null, '127.0.0.1');
  };
  return { ...fx, run };
}

test('a worker in an unreachable workspace reads as not found on PATCH and DELETE', async () => {
  const fx = routesFixture();
  await assert.rejects(
    () => fx.run('PATCH', '/api/board/workers/:id', { id: 'wkr-1' }, { name: 'Hijacked' }, outsider),
    (err) => err.status === 404,
  );
  assert.equal(fx.store.getWorker('wkr-1').name, 'Developer');
  await assert.rejects(
    () => fx.run('DELETE', '/api/board/workers/:id', { id: 'wkr-1' }, undefined, outsider),
    (err) => err.status === 404,
  );
  assert.ok(fx.store.getWorker('wkr-1'));
});

test('a member still manages workers, and an unknown id is not found', async () => {
  const fx = routesFixture();
  const { worker } = await fx.run('PATCH', '/api/board/workers/:id', { id: 'wkr-1' }, { name: 'Renamed' }, member);
  assert.equal(worker.name, 'Renamed');
  await assert.rejects(
    () => fx.run('PATCH', '/api/board/workers/:id', { id: 'wkr-none' }, { name: 'X' }, member),
    (err) => err.status === 404,
  );
  await fx.run('DELETE', '/api/board/workers/:id', { id: 'wkr-1' }, undefined, member);
  assert.equal(fx.store.getWorker('wkr-1'), undefined);
});

test('a workspace-scoped route answers not found, not forbidden, when out of reach', async () => {
  const fx = routesFixture();
  await assert.rejects(
    () => fx.run('POST', '/api/board/workers', {}, { workspaceId: 'ws-1', name: 'W', role: 'developer' }, outsider),
    (err) => err.status === 404,
  );
});
