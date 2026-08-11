import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import { ModuleKernel, route } from '../dist/server/index.js';

const log = { info() {}, warn() {}, error() {}, debug() {} };

const authenticator = { verify: () => null, require: () => {} };

/** Minimal in-memory kernel: a required core plus whatever `extras` describe. */
function kernel(extras) {
  return new ModuleKernel({
    appVersion: 'test',
    db: new Database(':memory:'),
    log,
    config: { host: '127.0.0.1', port: 0, maxLiveRuns: 1, authMode: 'password', github: { apiUrl: '', host: '' }, users: [] },
    secretEncryptionKey: Buffer.alloc(32, 1),
    modules: [
      {
        manifest: { id: 'core', title: 'Core', version: '1.0.0', required: true },
        load: async () => ({
          manifest: { id: 'core', title: 'Core', version: '1.0.0', required: true },
          provideAuthenticator: () => authenticator,
        }),
      },
      ...extras,
    ],
    broadcast: () => {},
    pushToUser: () => {},
    ws: { registerScopeResolver() {}, unregisterScopeResolver() {} },
  });
}

function module(id, server, manifestExtra = {}) {
  const manifest = { id, title: id, version: '1.0.0', ...manifestExtra };
  return { manifest, load: async () => ({ manifest, ...server }) };
}

const pingRoute = (id) =>
  route({ method: 'GET', path: `/api/${id}/ping`, access: 'public', handler: () => ({ ok: true }) });

test('a clean boot is ready and lists every module state', async () => {
  const k = kernel([
    module('solid', { routes: () => [pingRoute('solid')] }),
    module('shelved', {}, { autoInstall: false }),
  ]);
  await k.boot();

  const readiness = k.readiness();
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.modules, [
    { id: 'core', state: 'enabled' },
    { id: 'solid', state: 'enabled' },
    { id: 'shelved', state: 'available' },
  ]);
});

test('before boot finishes the kernel does not report ready', () => {
  const k = kernel([]);
  assert.equal(k.readiness().ready, false);
});

test('an optional module failing to activate degrades boot instead of killing it', async (t) => {
  const k = kernel([
    module('solid', { routes: () => [pingRoute('solid')] }),
    module('flaky', {
      routes: () => [pingRoute('flaky')],
      lifecycle: {
        onEnable: () => {
          throw new Error('activation exploded');
        },
      },
    }),
  ]);
  await k.boot();

  const readiness = k.readiness();
  assert.equal(readiness.ready, false);
  assert.deepEqual(
    readiness.modules.map((m) => [m.id, m.state]),
    [
      ['core', 'enabled'],
      ['solid', 'enabled'],
      ['flaky', 'failed'],
    ],
  );

  // The failed module's routes were pulled (503, attributed), the healthy
  // module keeps serving.
  const server = createServer((req, res) => void k.router.dispatch(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/solid/ping`)).status, 200);
  assert.equal((await fetch(`${base}/api/flaky/ping`)).status, 503);
});

test('a required module failing to activate stays fatal', async () => {
  const k = kernel([
    module(
      'vital',
      {
        lifecycle: {
          onEnable: () => {
            throw new Error('cannot start');
          },
        },
      },
      { required: true },
    ),
  ]);
  await assert.rejects(() => k.boot(), /cannot start/);
  assert.equal(k.readiness().ready, false);
});

test('disabling a failed module clears its failed state', async () => {
  const k = kernel([
    module('flaky', {
      lifecycle: {
        onEnable: () => {
          throw new Error('activation exploded');
        },
      },
    }),
  ]);
  await k.boot();
  assert.equal(k.readiness().ready, false);

  await k.disable('flaky');
  const readiness = k.readiness();
  assert.equal(readiness.ready, true);
  assert.deepEqual(
    readiness.modules.filter((m) => m.id === 'flaky'),
    [{ id: 'flaky', state: 'available' }],
  );
});
