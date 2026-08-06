import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import migrations from '../dist/api/migrations.js';
import { OperateStore } from '../dist/api/operate-store.js';
import { Orchestrator } from '../dist/api/orchestrator.js';

process.env.COMPANION_HOME = mkdtempSync(join(tmpdir(), 'companion-run-authority-'));

const CONFIG = { host: '127.0.0.1', port: 8904, maxLiveRuns: 3 };

function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  for (const migration of migrations) migration.up(db);
  const store = new OperateStore(db, {
    get: (key) => db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key)?.value ?? null,
    set: (key, value) => db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(key, value),
  });
  const orchestrator = new Orchestrator(store, CONFIG, {}, null, () => {});
  const stopped = [];
  const local = orchestrator.runners.localBackend;
  local.scratchDir = async (runId) => join(process.env.COMPANION_HOME, runId);
  local.spawn = async () => {};
  local.stop = async (runId) => { stopped.push(runId); };
  local.isLive = () => true;
  local.runTurn = async (runId) => ({ turnId: `turn-${runId}` });
  return { db, store, orchestrator, stopped };
}

function usageEvent(inputTokens, outputTokens) {
  return {
    id: 'usage-revoked',
    seq: 1,
    ts: Date.now(),
    sessionId: 'session-revoked',
    turnId: 'turn-revoked',
    source: 'provider',
    type: 'provider_response',
    inputTokens,
    outputTokens,
  };
}

test('run authority is checked before creation and every later interaction', async () => {
  const { db, store, orchestrator, stopped } = fixture();
  let allowed = true;
  orchestrator.setRunAuthorityResolver((username) => username === 'ana' && allowed);

  const run = await orchestrator.createRun({ kind: 'interactive', userId: 'ana' });
  await orchestrator.sendPrompt(run.id, 'first turn');

  allowed = false;
  await assert.rejects(() => orchestrator.sendPrompt(run.id, 'must not run'), /no longer has runs:read/);
  assert.equal(store.runs.get(run.id).status, 'failed');
  assert.match(store.runs.get(run.id).outcome, /authority revoked/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(stopped, [run.id]);

  const before = store.runs.list().length;
  await assert.rejects(
    () => orchestrator.createRun({ kind: 'analysis', userId: 'ana' }),
    /no longer has runs:read/,
  );
  assert.equal(store.runs.list().length, before, 'refused creation must not persist a row');
  db.close();
});

test('live events fail a revoked run closed while retaining already-spent usage', async () => {
  const { db, store, orchestrator, stopped } = fixture();
  let allowed = true;
  orchestrator.setRunAuthorityResolver(() => allowed);
  const run = await orchestrator.createRun({ kind: 'analysis', userId: 'ana' });

  allowed = false;
  orchestrator.onEvent(run.id, usageEvent(120, 15));
  await new Promise((resolve) => setImmediate(resolve));

  const row = store.runs.get(run.id);
  assert.equal(row.status, 'failed');
  assert.equal(row.input_tokens, 120);
  assert.equal(row.output_tokens, 15);
  assert.deepEqual(stopped, [run.id]);
  db.close();
});

test('periodic reconciliation releases silent review runs after owner revocation', async () => {
  const { db, store, orchestrator, stopped } = fixture();
  let allowed = true;
  orchestrator.setRunAuthorityResolver(() => allowed);
  const run = await orchestrator.createRun({ kind: 'fix', userId: 'ana' });
  orchestrator.markRun(run.id, 'review');

  allowed = false;
  assert.equal(orchestrator.reapUnauthorizedRuns(), 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.runs.get(run.id).status, 'failed');
  assert.deepEqual(stopped, [run.id]);
  db.close();
});
