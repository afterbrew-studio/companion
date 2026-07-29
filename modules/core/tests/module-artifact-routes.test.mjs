import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DynamicRouter, HttpError } from '@moxxy/companion-core/server';
import routes from '../dist/api/routes.js';

/**
 * The artifact routes over real HTTP, through the real router, because the two
 * things worth proving here are both about what happens BEFORE a handler runs:
 * that a caller without the permission is refused without anything having been
 * downloaded or deleted, and that a module compiled into the build is refused
 * whatever the caller holds.
 */

const ADMIN = { username: 'admin', role: 'admin', permissions: ['modules:manage', 'modules:deploy'] };
const VIEWER = { username: 'viewer', role: 'business', permissions: ['modules:manage'] };
const USERS = { admin: ADMIN, viewer: VIEWER };

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/** A module directory as an npm tarball would have left it. */
function plant(root, id) {
  const dir = join(root, id);
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'dist', 'api.js'), 'export default {};\n');
  writeFileSync(join(dir, 'dist', 'module.js'), 'export default {};\n');
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: `companion-module-${id}`,
      version: '1.0.0',
      moxxy: { id, abi: '0.x', api: './dist/api.js', manifest: './dist/module.js' },
    }),
  );
  return dir;
}

const listing = (id, over = {}) => ({
  id,
  title: id,
  version: '1.0.0',
  dependsOn: [],
  required: false,
  installed: true,
  enabled: false,
  configured: true,
  permissions: [],
  config: [],
  external: true,
  externalClient: false,
  ...over,
});

async function harness(t, { catalog = [] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'companion-routes-'));
  const previousHome = process.env.COMPANION_HOME;
  process.env.COMPANION_HOME = home;
  const modulesRoot = join(home, 'modules');
  mkdirSync(modulesRoot, { recursive: true });

  const calls = [];
  const audited = [];
  const ctx = {
    log: noopLog,
    broadcast: () => calls.push({ op: 'broadcast' }),
    audit: { record: (e) => audited.push(e) },
    services: { get: () => ({}) },
    modules: {
      list: () => catalog,
      uninstall: async (id) => {
        // The contract this ordering exists for: down() migrations run while
        // the code that defines them is still on disk.
        calls.push({ op: 'uninstall', id, filesStillThere: existsSync(join(modulesRoot, id)) });
      },
      forget: (id) => calls.push({ op: 'forget', id }),
    },
  };

  const router = new DynamicRouter(
    {
      verify: (token) => USERS[token ?? ''] ?? null,
      require: (user, permission) => {
        if (!user?.permissions.includes(permission)) throw new HttpError(403, `requires ${permission}`);
      },
    },
    noopLog,
    (e) => audited.push(e),
  );
  router.mount('core', routes(ctx));

  const server = createServer((req, res) => void router.dispatch(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  t.after(() => {
    server.close();
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.COMPANION_HOME;
    else process.env.COMPANION_HOME = previousHome;
  });

  const call = async (method, path, { as = 'admin', body } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${as}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  return { call, calls, audited, modulesRoot };
}

test('adding a module needs modules:deploy, and a refusal downloads nothing', async (t) => {
  const h = await harness(t);

  const res = await h.call('POST', '/api/modules/add', { as: 'viewer', body: { spec: 'companion-module-reports' } });

  assert.equal(res.status, 403);
  // modules:manage moves switches on code that is already here. Fetching and
  // running new code is the bigger capability and is asked for separately.
  assert.match(res.body.error, /modules:deploy/);
  assert.deepEqual(h.calls, [], 'nothing else may have happened either');
  assert.deepEqual(
    h.audited.map((e) => [e.action, e.actor, e.status]),
    [['POST /api/modules/add', 'viewer', 403]],
    'a refusal is recorded once, and it is the router that records it',
  );
  assert.equal(h.audited.every((e) => e.detail === undefined), true, 'a detail line would mean the handler ran');
});

test('a UI spec that is not a registry package is refused before npm ever sees it', async (t) => {
  const h = await harness(t);

  for (const spec of ['/etc', './build', '../..', 'git+ssh://git@github.com/acme/evil.git', 'github:acme/evil']) {
    const res = await h.call('POST', '/api/modules/add', { body: { spec } });
    assert.equal(res.status, 400, `accepted '${spec}'`);
  }
  // The point of the difference: a permitted caller gets 400 where an
  // unpermitted one got 403, so authorization is not what stopped these.
  assert.deepEqual(h.calls, []);
});

test('remove refuses a module compiled into this build, whoever asks', async (t) => {
  const h = await harness(t, { catalog: [listing('slop', { external: false })] });
  const dir = plant(h.modulesRoot, 'slop');

  const res = await h.call('POST', '/api/modules/slop/remove');

  assert.equal(res.status, 403);
  assert.match(res.body.error, /compiled into this build/);
  assert.equal(existsSync(dir), true, 'a build module has no artifact to delete, so deleting one would be a mystery');
  assert.deepEqual(h.calls, [], 'and its migrations must not be rolled back either');
});

test('removing an out-of-tree module uninstalls it first, then deletes its files', async (t) => {
  const h = await harness(t, { catalog: [listing('reports')] });
  const dir = plant(h.modulesRoot, 'reports');
  writeFileSync(join(h.modulesRoot, '.provenance.json'), JSON.stringify({ reports: { spec: 'x', name: 'n', version: '1.0.0' } }));

  const res = await h.call('POST', '/api/modules/reports/remove');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { id: 'reports', uninstalled: true, deleted: true });
  assert.equal(existsSync(dir), false, 'uninstall alone leaves the files, so the next boot scans it back in');
  assert.deepEqual(
    h.calls.filter((c) => c.op !== 'broadcast'),
    [
      { op: 'uninstall', id: 'reports', filesStillThere: true },
      { op: 'forget', id: 'reports' },
    ],
  );
  assert.equal(h.calls.some((c) => c.op === 'broadcast'), true, 'every other browser is looking at a stale list');
});

test('removing needs modules:deploy too, and a refusal deletes nothing', async (t) => {
  const h = await harness(t, { catalog: [listing('reports')] });
  const dir = plant(h.modulesRoot, 'reports');

  const res = await h.call('POST', '/api/modules/reports/remove', { as: 'viewer' });

  assert.equal(res.status, 403);
  assert.equal(existsSync(dir), true);
  assert.deepEqual(h.calls, []);
});

test('files that arrived after boot are listed as not loaded, with where they came from', async (t) => {
  const h = await harness(t, { catalog: [listing('reports')] });
  plant(h.modulesRoot, 'reports');
  plant(h.modulesRoot, 'newcomer');
  writeFileSync(
    join(h.modulesRoot, '.provenance.json'),
    JSON.stringify({
      newcomer: {
        spec: 'companion-module-newcomer@2.1.0',
        name: 'companion-module-newcomer',
        version: '2.1.0',
        integrity: 'sha512-abc',
        registry: 'https://registry.npmjs.org/',
        addedAt: '2026-01-01T00:00:00.000Z',
      },
    }),
  );

  const { status, body } = await h.call('GET', '/api/modules/external');

  assert.equal(status, 200);
  const byId = Object.fromEntries(body.modules.map((m) => [m.id, m]));
  assert.equal(byId.reports.loaded, true);
  // The whole reason the page shows this: files on disk are not a loaded module.
  assert.equal(byId.newcomer.loaded, false);
  assert.equal(byId.newcomer.provenance.integrity, 'sha512-abc');
  assert.equal(byId.newcomer.provenance.registry, 'https://registry.npmjs.org/');
  assert.equal(byId.reports.provenance, null, 'copied in by hand, and the list says so rather than guessing');
});

test('reading the artifact list does not require the permission to change it', async (t) => {
  const h = await harness(t);
  assert.equal((await h.call('GET', '/api/modules/external', { as: 'viewer' })).status, 200);
});
