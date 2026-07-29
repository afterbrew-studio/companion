import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import migrations from '../dist/api/migrations.js';
import { OperateStore } from '../dist/api/operate-store.js';
import { Orchestrator } from '../dist/api/orchestrator.js';
import { LOCAL_RUNNER_ID } from '../dist/api/runners-store.js';

process.env.COMPANION_HOME = mkdtempSync(join(tmpdir(), 'companion-model-selection-'));

const CONFIG = { host: '127.0.0.1', port: 8901, maxLiveRuns: 3, defaultModel: 'opus' };

const provider = (name, models) => ({
  name,
  enabled: true,
  ready: true,
  models: models.map((id) => ({ id, contextWindow: null })),
});

/**
 * An orchestrator over a seeded store. Its registry rebuilds the model index on
 * construction, and a remote row without an endpoint builds no backend, so
 * nothing here opens a socket or spawns a gateway.
 */
function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  for (const m of migrations) m.up(db);
  const store = new OperateStore(db, {
    get: (key) => db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key)?.value ?? null,
    set: (key, value) => db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(key, value),
  });
  store.runners.insert({
    id: 'runner-b',
    name: 'gpu-box',
    kind: 'remote',
    endpoint: null,
    token: null,
    scope: 'shared',
    ownerId: null,
    maxRuns: 3,
    workspaceIds: [],
  });
  const catalog = { providers: [provider('anthropic', ['opus', 'sonnet'])], defaultModel: 'opus', fetchedAt: Date.now() };
  store.runners.setCatalog(LOCAL_RUNNER_ID, catalog);
  store.runners.setCatalog('runner-b', catalog);
  return { store, orchestrator: new Orchestrator(store, CONFIG, {}, null, () => {}) };
}

function addRun(store, id, runnerId) {
  const now = Date.now();
  store.runs.insert({
    id,
    kind: 'interactive',
    status: 'idle',
    title: 'chat',
    cwd: '/tmp',
    repo: null,
    issueNumber: null,
    proposalId: null,
    branch: null,
    prUrl: null,
    model: null,
    runnerId,
    userId: null,
    task: null,
    harness: 'moxxy',
    createdAt: now,
    updatedAt: now,
    inputTokens: 0,
    outputTokens: 0,
    outcome: null,
  });
}

test('selecting a model the run\'s machine may not use is refused, not substituted', async () => {
  const { store, orchestrator } = fixture();
  addRun(store, 'run-local', null);
  addRun(store, 'run-b', 'runner-b');

  orchestrator.runners.setProviderPolicy(LOCAL_RUNNER_ID, { disabledProviders: [], disabledModels: ['sonnet'] });

  await assert.rejects(() => orchestrator.setRunModel('run-local', 'sonnet'), /not enabled on the machine/);
  // Nothing was quietly swapped in: the run still has no model of its own.
  assert.equal(store.runs.get('run-local').model, null);

  // The same model on the machine that still allows it goes through, which is
  // what per-runner scoping buys over one instance-wide list.
  await orchestrator.setRunModel('run-b', 'sonnet');
  assert.equal(store.runs.get('run-b').model, 'sonnet');
});

test('an unknown model id is still selectable, because refusal needs evidence', async () => {
  const { store, orchestrator } = fixture();
  addRun(store, 'run-local', null);

  // No machine's catalog mentions it, so nothing can be proven about it: a
  // machine may well serve a model it has not reported.
  await orchestrator.setRunModel('run-local', 'gpt-9');
  assert.equal(store.runs.get('run-local').model, 'gpt-9');
});

test('switching a machine off does not break the turns of runs already on it', async () => {
  const { store, orchestrator } = fixture();
  addRun(store, 'run-b', 'runner-b');

  // Only runner-b lists this model; taking it out of placement must not make
  // its live run refuse a model it can still serve.
  store.runners.setCatalog(LOCAL_RUNNER_ID, { providers: [], defaultModel: null, fetchedAt: Date.now() });
  await orchestrator.runners.update('runner-b', { enabled: false });

  await orchestrator.setRunModel('run-b', 'sonnet');
  assert.equal(store.runs.get('run-b').model, 'sonnet');
});

test('a run cannot start on a model no machine may use', async () => {
  const { orchestrator } = fixture();

  for (const id of [LOCAL_RUNNER_ID, 'runner-b']) {
    orchestrator.runners.setProviderPolicy(id, { disabledProviders: [], disabledModels: ['sonnet'] });
  }

  await assert.rejects(
    () => orchestrator.createRun({ kind: 'fix', model: 'sonnet' }),
    /no runner may use sonnet/,
  );
});
