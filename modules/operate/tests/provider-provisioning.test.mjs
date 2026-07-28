import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import migrations from '../dist/api/migrations.js';
import { OperateStore } from '../dist/api/operate-store.js';
import routesFactory from '../dist/api/routes.js';
import { Runners } from '../dist/api/runners-registry.js';
import { LOCAL_RUNNER_ID } from '../dist/api/runners-store.js';
import { runMoxxyProvision } from '../dist/exec/provision.js';

/**
 * Adding a model provider to a machine from the UI. Every test here is really
 * about one question: where the credential goes, and everywhere it must not.
 */

const HOME = mkdtempSync(join(tmpdir(), 'companion-provisioning-'));
process.env.COMPANION_HOME = HOME;

const KEY = 'sk-ant-secret-value-0123456789';

const SINK = {
  onEvent() {},
  onTurnComplete() {},
  onAsk() {},
  onAskResolved() {},
  onGone() {},
  onRunnerUnreachable() {},
};

// ---------- the CLI hop: what actually gets spawned ----------

/**
 * A stand-in for the moxxy binary that records how it was invoked. Extension-less
 * so node loads it as CommonJS wherever the temp dir lives.
 */
function fakeMoxxy(name, body) {
  const path = join(HOME, name);
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const RECORDER = `
const fs = require('fs');
let stdin = '';
try { stdin = fs.readFileSync(0, 'utf8'); } catch {}
fs.writeFileSync(process.env.FAKE_MOXXY_RECORD, JSON.stringify({
  argv: process.argv.slice(2),
  stdin,
  home: process.env.MOXXY_HOME,
}));
process.stdout.write(JSON.stringify({ provider: 'anthropic', key: process.env.FAKE_MOXXY_RECORD }));
`;

/** What moxxy does on a bad spec: quotes back what it was handed, on stderr. */
const ECHOES_THE_SPEC = `
const fs = require('fs');
const stdin = fs.readFileSync(0, 'utf8');
process.stderr.write('moxxy provision: unknown provider "nope" in ' + stdin + '\\n');
process.exit(1);
`;

function invocationOf(cli, spec, home = join(HOME, 'moxxy-home')) {
  const record = join(HOME, `record-${Math.random().toString(36).slice(2)}.json`);
  process.env.FAKE_MOXXY_RECORD = record;
  return runMoxxyProvision(cli, home, spec).then(() => JSON.parse(readFileSync(record, 'utf8')));
}

test('the key travels on stdin and never appears in argv', async () => {
  const cli = fakeMoxxy('moxxy-recorder', RECORDER);
  const call = await invocationOf(cli, { provider: 'anthropic', key: KEY, model: 'opus' });

  // argv is world-readable through `ps`: a key there is a key handed to every
  // other account on the machine.
  assert.ok(
    !call.argv.some((arg) => arg.includes(KEY)),
    `the credential reached argv: ${JSON.stringify(call.argv)}`,
  );
  assert.deepEqual(JSON.parse(call.stdin), { provider: 'anthropic', key: KEY, model: 'opus' });
});

test('the spec flag is written --spec=-, the only form moxxy parses', async () => {
  const cli = fakeMoxxy('moxxy-recorder', RECORDER);
  const call = await invocationOf(cli, { provider: 'anthropic', key: KEY });

  assert.deepEqual(call.argv, ['provision', '--spec=-']);
  // `--spec -` makes moxxy's parser read the bare `-` as another flag, hand its
  // string flag a boolean, and fall through to printing usage: exit 0, nothing
  // provisioned. The pair form must never come back.
  assert.equal(call.argv.indexOf('-'), -1, 'a bare `-` argument means the flag was split');
});

test('provisioning targets the runner’s moxxy home, not whatever ~/.moxxy is', async () => {
  const cli = fakeMoxxy('moxxy-recorder', RECORDER);
  const home = join(HOME, 'some-runner-home');
  const call = await invocationOf(cli, { provider: 'anthropic', key: KEY }, home);

  assert.equal(call.home, home);
});

test('a failure that quotes the spec back comes out with the key redacted', async () => {
  const cli = fakeMoxxy('moxxy-echoes', ECHOES_THE_SPEC);

  await assert.rejects(
    () => runMoxxyProvision(cli, join(HOME, 'moxxy-home'), { provider: 'nope', key: KEY }),
    (err) => {
      assert.ok(!err.message.includes(KEY), `the credential was surfaced verbatim: ${err.message}`);
      assert.match(err.message, /\[redacted\]/);
      assert.match(err.message, /unknown provider/, 'moxxy’s own diagnosis must survive the scrub');
      return true;
    },
  );
});

test('a machine without moxxy says so instead of leaking a spawn error', async () => {
  await assert.rejects(
    () => runMoxxyProvision(join(HOME, 'no-such-binary'), join(HOME, 'moxxy-home'), { provider: 'anthropic' }),
    /moxxy is not installed on this machine/,
  );
});

// ---------- the registry hop: which machine, and what is kept ----------

function seededStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  for (const m of migrations) m.up(db);
  return new OperateStore(db, {
    get: (key) => db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key)?.value ?? null,
    set: (key, value) => db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(key, value),
  });
}

/**
 * A machine that answers like a healthy agent, recording every spec it is
 * handed and reporting the providers it has been given. `version` makes the two
 * machines in a fixture distinguishable, so "it went to the right one" cannot
 * pass merely because there was nowhere else to go.
 */
function recordingBackend(id, version, { fails } = {}) {
  const providers = ['anthropic'];
  const specs = [];
  return {
    id,
    specs,
    provisionProvider: async (spec) => {
      specs.push(spec);
      if (fails) throw new Error(fails);
      providers.push(spec.provider);
    },
    probe: async () => ({
      status: 'online',
      moxxyVersion: version,
      moxxyCompatible: true,
      liveRuns: 0,
      maxRuns: 3,
      lastSeenAt: Date.now(),
      detail: null,
      providers: [...providers],
    }),
    spawn: async () => {},
    stop: async () => {},
    isLive: () => false,
    liveIds: () => [],
    scratchDir: async (runId) => join(HOME, id, runId),
    cleanupStorage: async () => ({
      removedWorktrees: 0,
      removedScratchDirs: 0,
      removedSessionFiles: 0,
      removedRunConfigs: 0,
      errors: [],
    }),
    sessionInfo: async () => ({
      activeProvider: 'anthropic',
      readyProviders: [...providers],
      providers: providers.map((name) => ({ name, enabled: true, models: [{ id: `${name}-model` }] })),
    }),
  };
}

/** Two machines, both really reachable; see the note on `recordingBackend`. */
function fleet({ owners = {} } = {}) {
  const db = new Database(':memory:');
  const store = seededStore(db);
  for (const id of ['runner-b', 'runner-c']) {
    store.runners.insert({
      id,
      name: id,
      kind: 'remote',
      endpoint: null,
      token: null,
      scope: 'shared',
      ownerId: owners[id] ?? null,
      maxRuns: 3,
      workspaceIds: [],
    });
  }
  const broadcasts = [];
  const runners = new Runners(store, {}, null, 3, SINK, (msg) => broadcasts.push(msg));
  const backends = {
    'runner-b': recordingBackend('runner-b', '1.0.0'),
    'runner-c': recordingBackend('runner-c', '2.0.0'),
  };
  for (const [id, backend] of Object.entries(backends)) runners.backends.set(id, backend);
  return { db, store, runners, backends, broadcasts };
}

/** Everything the daemon persisted, as one string to search for a credential. */
function everythingStored(db) {
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all();
  return JSON.stringify(tables.map((t) => db.prepare(`SELECT * FROM "${t.name}"`).all()));
}

test('the provider lands on the machine that was named, and on no other', async () => {
  const { runners, backends } = fleet();

  const result = await runners.provisionProvider('runner-c', { provider: 'openai', key: KEY });

  assert.deepEqual(backends['runner-c'].specs, [{ provider: 'openai', key: KEY }]);
  assert.deepEqual(backends['runner-b'].specs, [], 'the other machine was handed the credential too');
  // The re-probe must be of the same machine, not of whichever one is first.
  assert.equal(result.health.moxxyVersion, '2.0.0');
});

test('nothing about the credential is written to the database', async () => {
  const { db, runners } = fleet();

  await runners.provisionProvider('runner-b', { provider: 'openai', key: KEY, model: 'gpt' });

  const stored = everythingStored(db);
  assert.ok(!stored.includes(KEY), 'the credential was persisted');
  // The provider name is fine to keep: it is what the machine now advertises.
  assert.ok(stored.includes('openai'), 'the new provider never reached the machine’s catalog');
});

test('adding a provider re-reads the machine and tells the browser', async () => {
  const { store, runners, broadcasts } = fleet();
  broadcasts.length = 0;

  const result = await runners.provisionProvider('runner-b', { provider: 'openai', key: KEY });

  assert.ok(result.health.providers.includes('openai'), 'health still reports the old provider set');
  assert.ok(
    store.runners.get('runner-b').catalog.providers.some((p) => p.name === 'openai'),
    'the machine’s catalog was not refreshed, so the new model is unreachable',
  );
  assert.ok(broadcasts.some((msg) => msg.t === 'runners.changed'));
});

test('a machine that quotes the key back has it scrubbed before the daemon repeats it', async () => {
  const { runners } = fleet();
  const hostile = recordingBackend('runner-b', '1.0.0', {
    fails: `moxxy provision: invalid spec {"provider":"openai","key":"${KEY}"}`,
  });
  runners.backends.set('runner-b', hostile);

  await assert.rejects(
    () => runners.provisionProvider('runner-b', { provider: 'openai', key: KEY }),
    (err) => {
      assert.ok(!err.message.includes(KEY), `the credential came back out: ${err.message}`);
      assert.match(err.message, /\[redacted\]/);
      return true;
    },
  );
});

test('an agent too old to provision is named as the thing to update', async () => {
  const { runners } = fleet();
  runners.backends.set(
    'runner-b',
    recordingBackend('runner-b', '1.0.0', { fails: 'no route: POST /agent/providers' }),
  );

  await assert.rejects(
    () => runners.provisionProvider('runner-b', { provider: 'openai', key: KEY }),
    /update it on the machine once/,
  );
});

// ---------- the route hop: who is allowed to do it ----------

const GRID = {
  admin: ['runners:connect', 'runners:manage'],
  business: ['runners:connect'],
};

function addProviderRoute(runners) {
  const ctx = {
    services: {
      get: (id) =>
        id === 'operate'
          ? { runners, runTaskDescriptors: () => [] }
          : { canAccessWorkspace: () => true, canAccessRepo: () => true },
    },
    rbac: { has: (role, perm) => (GRID[role] ?? []).includes(perm), roles: () => [], hasRole: () => true },
    modules: { list: () => [] },
    config: { defaultModel: 'opus' },
    broadcast: () => {},
    log: { info() {}, warn() {} },
  };
  const route = routesFactory(ctx).find((r) => r.method === 'POST' && r.path === '/api/runners/:id/providers');
  assert.ok(route, 'the add-provider route is not mounted');
  return route;
}

const call = (route, id, user, body = { provider: 'openai', key: KEY }) =>
  route.run({ id }, new URLSearchParams(), body, user, null);

test('the route carries the same authority that manages a machine', () => {
  const { runners } = fleet();
  assert.equal(addProviderRoute(runners).access, 'runners:connect');
});

test('someone who cannot manage the machine is refused, and it never sees the key', async () => {
  const { runners, backends } = fleet();
  const route = addProviderRoute(runners);

  await assert.rejects(
    () => call(route, 'runner-b', { username: 'bo', role: 'business' }),
    /runner runner-b not found/,
  );
  assert.deepEqual(backends['runner-b'].specs, [], 'the credential was forwarded before the check');
});

test('an admin may provision a shared machine; nobody may provision someone else’s', async () => {
  const { runners, backends } = fleet({ owners: { 'runner-c': 'ana' } });
  const route = addProviderRoute(runners);
  const admin = { username: 'root', role: 'admin' };

  await call(route, 'runner-b', admin);
  assert.equal(backends['runner-b'].specs.length, 1);

  // A private machine stays private, admin or not: ownership is not delegated.
  await assert.rejects(() => call(route, 'runner-c', admin), /runner runner-c not found/);
  assert.deepEqual(backends['runner-c'].specs, []);

  // Its owner holds only runners:connect, and that is enough for their own.
  await call(route, 'runner-c', { username: 'ana', role: 'business' });
  assert.equal(backends['runner-c'].specs.length, 1);
});

test('the reply never carries the credential back', async () => {
  const { runners } = fleet();
  const route = addProviderRoute(runners);

  const result = await call(route, 'runner-b', { username: 'root', role: 'admin' });

  assert.ok(!JSON.stringify(result).includes(KEY));
});

test('the local runner is provisionable the same way, through the same route', async () => {
  const { runners, backends } = fleet();
  const local = recordingBackend(LOCAL_RUNNER_ID, '3.0.0');
  runners.backends.set(LOCAL_RUNNER_ID, local);
  const route = addProviderRoute(runners);

  const result = await call(route, LOCAL_RUNNER_ID, { username: 'root', role: 'admin' });

  assert.equal(result.health.moxxyVersion, '3.0.0');
  assert.deepEqual(local.specs, [{ provider: 'openai', key: KEY }]);
  assert.deepEqual(backends['runner-b'].specs, []);
});
