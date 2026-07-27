import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanExternalModules, installAbiBridge, ABI_GENERATION } from '../dist/server/index.js';

function home() {
  const dir = mkdtempSync(join(tmpdir(), 'companion-ext-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A module directory laid out the way an installed npm tarball would be. */
function plant(root, id, { pkg = {}, moxxy = {}, files = ['dist/api.js', 'dist/module.js'] } = {}) {
  const dir = join(root, id);
  mkdirSync(join(dir, 'dist'), { recursive: true });
  for (const f of files) writeFileSync(join(dir, f), 'export default {};\n');
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: `companion-module-${id}`,
      version: '1.0.0',
      moxxy: { id, abi: ABI_GENERATION, api: './dist/api.js', manifest: './dist/module.js', ...moxxy },
      ...pkg,
    }),
  );
  return dir;
}

test('a well-formed module is accepted with its metadata', (t) => {
  const h = home();
  t.after(h.cleanup);
  plant(h.dir, 'hello');

  const { modules, problems } = scanExternalModules(h.dir);
  assert.deepEqual(problems, []);
  assert.equal(modules.length, 1);
  assert.equal(modules[0].meta.id, 'hello');
  assert.equal(modules[0].version, '1.0.0');
});

test('the ABI bridge directory is not mistaken for a module', (t) => {
  const h = home();
  t.after(h.cleanup);
  plant(h.dir, 'hello');
  mkdirSync(join(h.dir, 'node_modules', '@moxxy-ai'), { recursive: true });

  const { modules, problems } = scanExternalModules(h.dir);
  assert.deepEqual(problems, []);
  assert.deepEqual(modules.map((m) => m.meta.id), ['hello']);
});

test('a module that vendors the SDK is refused', (t) => {
  const h = home();
  t.after(h.cleanup);
  const dir = plant(h.dir, 'hello');
  mkdirSync(join(dir, 'node_modules', '@moxxy-ai', 'companion-sdk'), { recursive: true });

  const { modules, problems } = scanExternalModules(h.dir);
  assert.deepEqual(modules, [], 'a second SDK copy makes `instanceof Reply` false in the router');
  assert.match(problems[0].reason, /ships its own copy/);
});

test('a module built against another ABI generation is refused by name', (t) => {
  const h = home();
  t.after(h.cleanup);
  plant(h.dir, 'hello', { moxxy: { abi: '9.x' } });

  const { problems } = scanExternalModules(h.dir);
  assert.match(problems[0].reason, /9\.x.*implements 0\.x/);
});

test('the id must match the directory, so one module cannot shadow another', (t) => {
  const h = home();
  t.after(h.cleanup);
  plant(h.dir, 'hello', { moxxy: { id: 'core' } });

  const { modules, problems } = scanExternalModules(h.dir);
  assert.deepEqual(modules, []);
  assert.match(problems[0].reason, /must match the directory/);
});

test('an entry path that escapes the module directory is refused', (t) => {
  const h = home();
  t.after(h.cleanup);
  plant(h.dir, 'hello', { moxxy: { api: '../../../etc/passwd' } });

  const { problems } = scanExternalModules(h.dir);
  assert.match(problems[0].reason, /outside the module directory/);
});

test('a missing entry file is reported instead of failing at import time', (t) => {
  const h = home();
  t.after(h.cleanup);
  plant(h.dir, 'hello', { files: ['dist/module.js'] });

  const { problems } = scanExternalModules(h.dir);
  assert.match(problems[0].reason, /dist\/api\.js, which does not exist/);
});

test('a directory that is not a Companion module is skipped, not fatal', (t) => {
  const h = home();
  t.after(h.cleanup);
  mkdirSync(join(h.dir, 'notes'));
  writeFileSync(join(h.dir, 'notes', 'package.json'), JSON.stringify({ name: 'notes' }));
  plant(h.dir, 'hello');

  const { modules, problems } = scanExternalModules(h.dir);
  assert.deepEqual(modules.map((m) => m.meta.id), ['hello'], 'one bad neighbour must not take the good ones down');
  assert.match(problems[0].reason, /no "moxxy" block/);
});

test('the bridge re-exports exactly the host namespace, and only that', async (t) => {
  const h = home();
  t.after(h.cleanup);
  const namespaces = { '.': { alpha: 1 }, './server': { Reply: class {}, badRequest: () => {} }, './agents': {} };
  installAbiBridge({ dir: h.dir, version: '9.9.9', namespaces });

  const bridged = await import(join(h.dir, 'node_modules', '@moxxy-ai', 'companion-sdk', 'server.js'));
  assert.deepEqual(Object.keys(bridged).sort(), ['Reply', 'badRequest']);
  // Identity, not a copy: this is the whole reason the bridge exists.
  assert.equal(bridged.Reply, namespaces['./server'].Reply);
});

test('importing the bridge outside a daemon fails loudly', async (t) => {
  const h = home();
  t.after(h.cleanup);
  installAbiBridge({ dir: h.dir, version: '9.9.9', namespaces: { '.': { alpha: 1 } } });
  // What a stray `node dist/api.js` would hit: no host, so no ABI table.
  delete globalThis[Symbol.for('companion.abi')];

  await assert.rejects(
    () => import(`${join(h.dir, 'node_modules', '@moxxy-ai', 'companion-sdk', 'index.js')}?v=2`),
    /imported outside a Companion daemon/,
  );
});
