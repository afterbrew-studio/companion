import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const snapshot = JSON.parse(readFileSync(new URL('../surface.json', import.meta.url), 'utf8'));

const runtime = {
  '.': await import('../dist/index.js'),
  './server': await import('../dist/server.js'),
  './agents': await import('../dist/agents.js'),
};

test('every value the snapshot names is actually exported', () => {
  for (const [entry, mod] of Object.entries(runtime)) {
    const live = new Set(Object.keys(mod));
    // Types vanish at runtime, so this checks the ones that survive: a snapshot
    // naming a value that does not exist would be an ABI that lies.
    const missing = snapshot[entry].filter((n) => !live.has(n) && looksLikeValue(n));
    assert.deepEqual(missing, [], `${entry} promises values it does not export`);
  }
});

test('nothing is exported that the snapshot does not name', () => {
  for (const [entry, mod] of Object.entries(runtime)) {
    const extra = Object.keys(mod).filter((n) => !snapshot[entry].includes(n));
    assert.deepEqual(extra, [], `${entry} leaks symbols past the reviewed surface`);
  }
});

/**
 * The curation is the product. If these ever resolve, a module can reach the
 * host's own machinery and the ABI stops being a boundary.
 */
test('host internals are not reachable through the SDK', () => {
  const forbidden = {
    './server': [
      'ModuleKernel',
      'KernelOptions',
      'DynamicRouter',
      'RawRouter',
      'MigrationRunner',
      'ServiceRegistry',
      'ServerBus',
      'RbacGrid',
      'WsHub',
      'WsScopeRegistry',
      'ModuleConfigStore',
      'SqliteSecretStore',
      'fieldSchema',
      'validatePatch',
      'readBody',
      'readRawBody',
      'requestDbRecreate',
    ],
  };
  for (const [entry, names] of Object.entries(forbidden)) {
    const leaked = names.filter((n) => n in runtime[entry]);
    assert.deepEqual(leaked, [], `${entry} exposes host internals`);
  }
});

test('the runner wire protocol stays private', () => {
  const wire = ['RpcRequestFrame', 'RpcResponseFrame', 'AgentDiffResponse', 'MOXXY_WS_SUBPROTOCOL', 'RUNNER_AGENT_PROTOCOL'];
  for (const entry of Object.keys(runtime)) {
    for (const n of wire) assert.ok(!(n in runtime[entry]), `${entry} exposes ${n}`);
    for (const n of wire) assert.ok(!snapshot[entry].includes(n), `${entry} snapshot names ${n}`);
  }
});

test('the client and ui entry points ship types but no runtime, like the packages they face', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  for (const entry of ['./client', './ui']) {
    const spec = pkg.exports[entry];
    // `source` for the host's Vite, `types` so an out-of-tree author can compile.
    assert.equal(spec.source?.startsWith('./src/'), true, `${entry} must expose source for the web host`);
    assert.equal(spec.types?.startsWith('./dist/'), true, `${entry} must expose declarations to external authors`);
    // A runtime path here would be a SECOND React: the browser gets these
    // through the import map, never through package resolution.
    assert.equal(spec.default, undefined, `${entry} must not offer a runtime path`);
    assert.equal(spec.import, undefined, `${entry} must not offer a runtime path`);
  }
  // ...and the buildable ones must NOT be source-only, or the daemon cannot load them.
  for (const entry of ['.', './server', './agents']) {
    assert.ok(pkg.exports[entry].default?.startsWith('./dist/'), `${entry} needs a built default`);
  }
});

/** PascalCase with no runtime member is a type; anything else should exist at runtime. */
function looksLikeValue(name) {
  return !/^[A-Z]/.test(name) || ['Reply', 'HttpError', 'ApiError', 'OnboardingArt', 'Slot', 'NavIcon'].includes(name);
}
