import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimeService } from '../dist/api/runtime-service.js';

/**
 * The provider registry's write semantics: the tri-state credential on PATCH
 * (absent keeps, a string replaces, null clears), and the models column under
 * concurrency, where a probe observation must survive both a racing probe and
 * an operator edit built from a stale read.
 */

function memoryStore() {
  const rows = new Map();
  return {
    list: () => [...rows.values()],
    get: (id) => rows.get(id) ?? null,
    insert: (row) => rows.set(row.id, row),
    update: (row) => rows.set(row.id, row),
    delete: (id) => rows.delete(id),
  };
}

function service(probeFn) {
  const kept = new Map();
  const store = memoryStore();
  const runtime = new RuntimeService(
    store,
    memoryStore(),
    {
      get: (key) => kept.get(key) ?? null,
      set: (key, value) => kept.set(key, value),
      delete: (key) => kept.delete(key),
    },
    () => ({
      maxSteps: 40,
      turnTimeoutMinutes: 30,
      childMemoryMb: 1024,
      commandTimeoutMinutes: 10,
      approvalTimeoutMinutes: 10,
      toolOutputChars: 30_000,
    }),
    () => undefined,
    probeFn,
  );
  return { runtime, secrets: kept, store };
}

const model = (id, extra = {}) => ({
  id,
  label: null,
  contextWindow: null,
  inputPerMTok: null,
  outputPerMTok: null,
  probed: null,
  options: null,
  ...extra,
});

const provider = (models = [model('m1')]) => ({
  label: 'Gateway',
  kind: 'openai-compatible',
  baseUrl: 'https://llm.example/v1',
  apiKey: 'k1',
  models,
});

// ---------- credential tri-state ---------------------------------------------

test('a patch without apiKey keeps the stored credential', async () => {
  const { runtime } = service();
  const { id } = runtime.create(provider());
  const updated = await runtime.update(id, { label: 'Renamed' });
  assert.equal(updated.label, 'Renamed');
  assert.equal(updated.hasKey, true);
});

test('an empty apiKey keeps the stored credential, because that is what an untouched form sends', async () => {
  const { runtime, secrets } = service();
  const { id } = runtime.create(provider());
  const updated = await runtime.update(id, { apiKey: '' });
  assert.equal(updated.hasKey, true);
  assert.equal(secrets.get(`provider:${id}:key`), 'k1');
});

test('a string apiKey replaces the stored credential', async () => {
  const { runtime, secrets } = service();
  const { id } = runtime.create(provider());
  const updated = await runtime.update(id, { apiKey: 'k2' });
  assert.equal(updated.hasKey, true);
  assert.equal(secrets.get(`provider:${id}:key`), 'k2');
});

test('a null apiKey clears the stored credential', async () => {
  const { runtime, secrets } = service();
  const { id } = runtime.create(provider());
  const updated = await runtime.update(id, { apiKey: null });
  assert.equal(updated.hasKey, false);
  assert.equal(secrets.get(`provider:${id}:key`), undefined);
});

test('the MCP secret follows the same tri-state', async () => {
  const { runtime, secrets } = service();
  const { id } = runtime.createMcp({ label: 'Srv', transport: 'http', url: 'https://mcp.example/mcp', secret: 's1' });
  const key = `mcp:${id}:secret`;

  assert.equal(runtime.updateMcp(id, { label: 'Renamed' }).hasSecret, true, 'absent keeps');
  assert.equal(secrets.get(key), 's1');
  assert.equal(runtime.updateMcp(id, { secret: '' }).hasSecret, true, 'empty keeps');
  assert.equal(secrets.get(key), 's1');
  assert.equal(runtime.updateMcp(id, { secret: 's2' }).hasSecret, true, 'a string replaces');
  assert.equal(secrets.get(key), 's2');
  assert.equal(runtime.updateMcp(id, { secret: null }).hasSecret, false, 'null clears');
  assert.equal(secrets.get(key), undefined);
});

// ---------- the models column under concurrency ------------------------------

test('an edit built from a stale read cannot erase a probe observation', async () => {
  const { runtime } = service(async () => ({ ok: true, tools: true, streaming: true, at: 5, detail: null }));
  const { id } = runtime.create(provider());
  await runtime.probe(id, 'm1');

  // The browser rendered before the probe finished, so its copy says
  // `probed: null`; saving prices from it must not un-observe the model.
  const saved = await runtime.update(id, { models: [model('m1', { inputPerMTok: 3, outputPerMTok: 15 })] });
  assert.equal(saved.models[0].inputPerMTok, 3);
  assert.equal(saved.models[0].probed?.ok, true, 'the observation survived the stale edit');
});

test('a patch cannot invent a probe observation either', async () => {
  const { runtime } = service();
  const { id } = runtime.create(provider());
  const forged = model('m1', { probed: { ok: true, tools: true, streaming: true, at: 1, detail: null } });
  const saved = await runtime.update(id, { models: [forged] });
  assert.equal(saved.models[0].probed, null);
});

test('two concurrent probes both land their observations', async () => {
  const gates = new Map();
  const { runtime } = service(
    (spec) =>
      new Promise((resolve) => {
        gates.set(spec.model, () => resolve({ ok: true, tools: true, streaming: true, at: 1, detail: spec.model }));
      }),
  );
  const { id } = runtime.create(provider([model('m1'), model('m2')]));

  const first = runtime.probe(id, 'm1');
  const second = runtime.probe(id, 'm2');
  // The later-started probe answers first, so the writes land out of order.
  gates.get('m2')();
  await second;
  gates.get('m1')();
  await first;

  const record = runtime.get(id);
  assert.equal(record.models.find((m) => m.id === 'm1').probed?.detail, 'm1');
  assert.equal(record.models.find((m) => m.id === 'm2').probed?.detail, 'm2');
});

test('an edit landing while a probe is in flight loses neither the edit nor the observation', async () => {
  const gates = new Map();
  const { runtime } = service(
    (spec) =>
      new Promise((resolve) => {
        gates.set(spec.model, () => resolve({ ok: true, tools: false, streaming: true, at: 1, detail: null }));
      }),
  );
  const { id } = runtime.create(provider());

  const pending = runtime.probe(id, 'm1');
  await runtime.update(id, { models: [model('m1', { contextWindow: 200_000 })] });
  gates.get('m1')();
  await pending;

  const record = runtime.get(id);
  assert.equal(record.models[0].contextWindow, 200_000);
  assert.equal(record.models[0].probed?.ok, true);
});

test('a probe whose model was removed mid-flight records nothing', async () => {
  const gates = new Map();
  const { runtime } = service(
    (spec) =>
      new Promise((resolve) => {
        gates.set(spec.model, () => resolve({ ok: true, tools: true, streaming: true, at: 1, detail: null }));
      }),
  );
  const { id } = runtime.create(provider([model('m1'), model('m2')]));

  const pending = runtime.probe(id, 'm2');
  await runtime.update(id, { models: [model('m1')] });
  gates.get('m2')();
  await pending;

  const record = runtime.get(id);
  assert.deepEqual(record.models.map((m) => m.id), ['m1']);
});

// ---------- stored rows with unknown kinds -----------------------------------

test('a stored row with a kind this build has never heard of lists verbatim', () => {
  const { runtime, store } = service();
  store.insert({
    id: 'plug',
    label: 'Plugin endpoint',
    kind: 'somebody-elses-provider',
    base_url: 'https://llm.example/v1',
    headers: '{}',
    query: '{}',
    api_version: null,
    factory_options: '{}',
    models: JSON.stringify([model('m1')]),
    workspace_ids: null,
    enabled: 1,
    created_at: 1,
  });
  const [record] = runtime.list();
  assert.equal(record.kind, 'somebody-elses-provider');
  // Not one of the keyless-ready kinds, so with no credential it is not ready.
  assert.equal(runtime.ready(), false);
});
