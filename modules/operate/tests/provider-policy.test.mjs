import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import migrations from '../dist/api/migrations.js';
import { OperateStore } from '../dist/api/operate-store.js';
import { Runners } from '../dist/api/runners-registry.js';
import { LOCAL_RUNNER_ID } from '../dist/api/runners-store.js';

// Keep runtime-owned files isolated so these tests see only seeded catalogs.
process.env.COMPANION_HOME = mkdtempSync(join(tmpdir(), 'companion-provider-policy-'));

const SINK = {
  onEvent() {},
  onTurnComplete() {},
  onAsk() {},
  onAskResolved() {},
  onGone() {},
  onRunnerUnreachable() {},
};

function migrate(db, settings = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const set = db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`);
  for (const [key, value] of Object.entries(settings)) set.run(key, value);
  for (const m of migrations) m.up(db);
}

function settingsFacade(db) {
  return {
    get: (key) => db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key)?.value ?? null,
    set: (key, value) => db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(key, value),
  };
}

function fixture(settings = {}) {
  const db = new Database(':memory:');
  migrate(db, settings);
  return { db, store: new OperateStore(db, settingsFacade(db)) };
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

const provider = (name, models, ready = true) => ({
  name,
  enabled: true,
  ready,
  models: models.map((id) => ({ id, contextWindow: null })),
});

const catalogOf = (...providers) => ({
  providers,
  defaultModel: providers[0]?.models[0]?.id ?? null,
  fetchedAt: Date.now(),
});

/** The registry rebuilds its model index on construction, so seed the store first. */
const registry = (store) => new Runners(store, {}, null, 3, SINK, () => {});

const sorted = (ids) => [...ids].sort();

test('a provider switched off on one machine stays usable on another', () => {
  const { store } = fixture();
  addMachine(store, 'runner-b', 'gpu-box');
  const catalog = catalogOf(provider('anthropic', ['opus', 'sonnet']));
  store.runners.setCatalog(LOCAL_RUNNER_ID, catalog);
  store.runners.setCatalog('runner-b', catalog);

  const runners = registry(store);
  assert.deepEqual(sorted(runners.runnersForModel('opus')), sorted([LOCAL_RUNNER_ID, 'runner-b']));

  runners.setProviderPolicy(LOCAL_RUNNER_ID, { disabledProviders: ['anthropic'], disabledModels: [] });

  // The index drops the machine that switched the provider off...
  assert.deepEqual([...runners.runnersForModel('opus')], ['runner-b']);
  assert.deepEqual([...runners.runnersForModel('anthropic/opus')], ['runner-b']);
  assert.equal(runners.serves(LOCAL_RUNNER_ID, 'opus'), false);
  // ...while the model itself stays reachable, which is the point of scoping.
  assert.equal(runners.serves('runner-b', 'opus'), true);

  const snapshot = runners.catalogSnapshot();
  const merged = snapshot.providers.find((p) => p.name === 'anthropic');
  assert.deepEqual(merged.machines, ['runner-b']);
  assert.deepEqual(merged.disabledOn, [LOCAL_RUNNER_ID]);
  assert.deepEqual(
    merged.models.map((m) => m.machines),
    [['runner-b'], ['runner-b']],
  );

  const local = snapshot.machines.find((m) => m.id === LOCAL_RUNNER_ID);
  assert.equal(local.modelCount, 0);
  assert.equal(local.providers[0].enabled, false);
  assert.equal(local.providers[0].ready, true);
  assert.deepEqual(local.policy.disabledProviders, ['anthropic']);
  assert.equal(snapshot.machines.find((m) => m.id === 'runner-b').modelCount, 2);
});

test('a model switched off on one machine leaves the other serving it', () => {
  const { store } = fixture();
  addMachine(store, 'runner-b', 'gpu-box');
  const catalog = catalogOf(provider('anthropic', ['opus', 'sonnet']));
  store.runners.setCatalog(LOCAL_RUNNER_ID, catalog);
  store.runners.setCatalog('runner-b', catalog);
  const runners = registry(store);

  runners.setProviderPolicy('runner-b', { disabledProviders: [], disabledModels: ['sonnet'] });

  assert.deepEqual([...runners.runnersForModel('sonnet')], [LOCAL_RUNNER_ID]);
  assert.deepEqual(sorted(runners.runnersForModel('opus')), sorted([LOCAL_RUNNER_ID, 'runner-b']));
  assert.equal(runners.serves('runner-b', 'sonnet'), false);
  assert.equal(runners.serves('runner-b', 'opus'), true);

  const snapshot = runners.catalogSnapshot();
  const models = snapshot.providers.find((p) => p.name === 'anthropic').models;
  assert.deepEqual(models.find((m) => m.id === 'sonnet').machines, [LOCAL_RUNNER_ID]);
  assert.deepEqual(sorted(models.find((m) => m.id === 'opus').machines), sorted([LOCAL_RUNNER_ID, 'runner-b']));
  const b = snapshot.machines.find((m) => m.id === 'runner-b');
  assert.equal(b.modelCount, 1);
  assert.deepEqual(
    b.providers[0].models.map((m) => [m.id, m.enabled]),
    [
      ['opus', true],
      ['sonnet', false],
    ],
  );
});

test("a provider-scoped id switches off only that provider's copy of the model", () => {
  const { store } = fixture();
  store.runners.setCatalog(LOCAL_RUNNER_ID, catalogOf(provider('anthropic', ['opus']), provider('bedrock', ['opus'])));
  const runners = registry(store);

  runners.setProviderPolicy(LOCAL_RUNNER_ID, { disabledProviders: [], disabledModels: ['anthropic/opus'] });

  assert.deepEqual([...runners.runnersForModel('anthropic/opus')], []);
  assert.deepEqual([...runners.runnersForModel('bedrock/opus')], [LOCAL_RUNNER_ID]);
  // The bare id is still served here, through the provider left enabled.
  assert.deepEqual([...runners.runnersForModel('opus')], [LOCAL_RUNNER_ID]);
  assert.equal(runners.serves(LOCAL_RUNNER_ID, 'opus'), true);
});

test('the index tells "known but allowed nowhere" apart from "never reported"', () => {
  const { store } = fixture();
  addMachine(store, 'runner-b', 'gpu-box');
  store.runners.setCatalog(LOCAL_RUNNER_ID, catalogOf(provider('anthropic', ['opus'])));
  const runners = registry(store);

  // runner-b has never reported a catalog: it must not be refused a model that
  // some other machine happens to list.
  assert.deepEqual([...runners.runnersForModel('opus')], [LOCAL_RUNNER_ID]);
  assert.equal(runners.serves('runner-b', 'opus'), true);

  runners.setProviderPolicy(LOCAL_RUNNER_ID, { disabledProviders: [], disabledModels: ['opus'] });

  // Known, allowed nowhere: an empty set, which is what lets dispatch refuse.
  assert.deepEqual([...runners.runnersForModel('opus')], []);
  assert.equal(runners.serves(LOCAL_RUNNER_ID, 'opus'), false);
  // Never reported by anyone: null, which keeps every caller permissive.
  assert.equal(runners.runnersForModel('gpt-9'), null);
  assert.equal(runners.serves(LOCAL_RUNNER_ID, 'gpt-9'), true);
});

test('a provider without credentials serves nothing even while switched on', () => {
  const { store } = fixture();
  store.runners.setCatalog(LOCAL_RUNNER_ID, catalogOf(provider('anthropic', ['opus'], false)));
  const runners = registry(store);

  assert.deepEqual([...runners.runnersForModel('opus')], []);
  const snapshot = runners.catalogSnapshot();
  assert.deepEqual(snapshot.providers.find((p) => p.name === 'anthropic').machines, []);
  assert.deepEqual(snapshot.providers.find((p) => p.name === 'anthropic').disabledOn, []);
  const local = snapshot.machines[0];
  assert.equal(local.modelCount, 0);
  assert.equal(local.providers[0].ready, false);
  assert.equal(local.providers[0].enabled, true);
});

test("the merged view never carries another user's private machine", () => {
  const { store } = fixture();
  addMachine(store, 'runner-ana', 'ana-laptop', 'ana');
  addMachine(store, 'runner-bo', 'bo-laptop', 'bo');
  store.runners.setCatalog(LOCAL_RUNNER_ID, catalogOf(provider('anthropic', ['opus'])));
  store.runners.setCatalog('runner-ana', catalogOf(provider('openai', ['gpt'])));
  store.runners.setCatalog('runner-bo', catalogOf(provider('mistral', ['large'])));
  const runners = registry(store);

  const ana = runners.catalogSnapshot('ana');
  assert.deepEqual(sorted(ana.machines.map((m) => m.id)), sorted([LOCAL_RUNNER_ID, 'runner-ana']));
  assert.deepEqual(sorted(ana.providers.map((p) => p.name)), sorted(['anthropic', 'openai']));

  // Placement already scopes personal machines to their owner; the page must
  // not imply a model is reachable through someone else's laptop.
  const nobody = runners.catalogSnapshot(null);
  assert.deepEqual(nobody.machines.map((m) => m.id), [LOCAL_RUNNER_ID]);
});

test('the instance-wide policy is carried onto every existing machine, once', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const set = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`);
  set.run('disabledProviders', JSON.stringify(['openai']));
  set.run('disabledModels', JSON.stringify(['opus']));

  // An install that predates the per-runner columns, with a machine already bound.
  for (const m of migrations.filter((x) => x.version < 5)) m.up(db);
  db.prepare(
    `INSERT INTO runners (id, name, kind, scope, max_runs, enabled, created_at) VALUES (?, 'old', 'remote', 'shared', 3, 1, 0)`,
  ).run('runner-old');

  for (const m of migrations) m.up(db);
  // Additive and idempotent: a second pass must neither throw nor rewrite.
  for (const m of migrations) m.up(db);

  const row = db.prepare(`SELECT disabled_providers, disabled_models FROM runners WHERE id = ?`).get('runner-old');
  assert.deepEqual(JSON.parse(row.disabled_providers), ['openai']);
  assert.deepEqual(JSON.parse(row.disabled_models), ['opus']);

  // A machine bound after the upgrade starts open: the carried lists were a
  // one-off translation of the old instance-wide policy, not a new default.
  const store = new OperateStore(db, settingsFacade(db));
  addMachine(store, 'runner-new', 'new-box');
  assert.deepEqual(store.runners.get('runner-new').disabled_providers, []);
  assert.deepEqual(store.runners.get('runner-new').disabled_models, []);
  // The local runner is seeded by the store, after the migration, so it is open too.
  assert.deepEqual(store.runners.get(LOCAL_RUNNER_ID).disabled_providers, []);
});

test('dropping the runtime that read a catalog drops the providers it reported', () => {
  // The cache outlives the runtime that filled it, so a machine kept offering
  // credentials nothing selected on it could reach, listed as ready beside the
  // built-in runtime whose own models they duplicated. The model id is a
  // fixture one: a real one could also come from the Codex cache on the machine
  // running this test.
  const { store } = fixture();
  store.runners.setCatalog(LOCAL_RUNNER_ID, catalogOf(provider('openai-codex', ['gpt-fixture'])));

  store.runners.update(LOCAL_RUNNER_ID, { harnesses: ['moxxy'] });
  const withMoxxy = registry(store).catalogSnapshot();
  assert.deepEqual(withMoxxy.providers.map((p) => p.name), ['openai-codex']);
  assert.deepEqual([...registry(store).runnersForModel('gpt-fixture')], [LOCAL_RUNNER_ID]);

  store.runners.update(LOCAL_RUNNER_ID, { harnesses: ['codex'] });
  const runners = registry(store);
  const snapshot = runners.catalogSnapshot();
  assert.equal(snapshot.providers.some((p) => p.name === 'openai-codex'), false);
  // Unknown, not "known but allowed nowhere": no catalog lists it any more.
  assert.equal(runners.runnersForModel('gpt-fixture'), null);
  const local = snapshot.machines.find((m) => m.id === LOCAL_RUNNER_ID);
  assert.equal(local.providers.some((p) => p.name === 'openai-codex'), false);
});
