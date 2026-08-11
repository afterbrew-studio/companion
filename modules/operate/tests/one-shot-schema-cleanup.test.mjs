import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import migrations from '../dist/api/migrations.js';
import { OperateStore } from '../dist/api/operate-store.js';
import { Orchestrator } from '../dist/api/orchestrator.js';

process.env.COMPANION_HOME = mkdtempSync(join(tmpdir(), 'companion-schema-cleanup-'));

const CONFIG = { host: '127.0.0.1', port: 8904, maxLiveRuns: 3 };

function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  for (const migration of migrations) migration.up(db);
  const store = new OperateStore(db, {
    get: (key) => db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key)?.value ?? null,
    set: (key, value) => db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(key, value),
  });
  return { db, store, orchestrator: new Orchestrator(store, CONFIG, {}, null, () => {}) };
}

function addRun(store, id) {
  const now = Date.now();
  store.runs.insert({
    id,
    kind: 'analysis',
    status: 'running',
    title: 'one shot',
    cwd: '/tmp',
    repo: 'owner/repo',
    issueNumber: null,
    proposalId: null,
    branch: null,
    prUrl: null,
    model: 'claude-sonnet-4-6',
    runnerId: null,
    userId: 'ana',
    task: 'playground.run',
    harness: 'moxxy',
    createdAt: now,
    updatedAt: now,
    inputTokens: 0,
    outputTokens: 0,
    outcome: null,
  });
}

/**
 * The per-run resultSchema is recorded before the first prompt; the failure
 * path used to rethrow without removing it (only usageObservers were cleaned
 * in the finally), leaking one entry per failed schema-carrying one-shot.
 */
test('a failed one-shot removes its resultSchemas entry', async () => {
  const { db, orchestrator, store } = fixture();
  addRun(store, 'run-fail');
  orchestrator.createRun = async () => ({ id: 'run-fail' });
  orchestrator.sendPrompt = async () => ({ turnId: 'turn-fail' });
  orchestrator.waitForTurn = () => Promise.reject(new Error('turn exploded'));
  orchestrator.stopRun = async () => undefined;

  await assert.rejects(
    orchestrator.runOneShot({
      kind: 'analysis',
      title: 'one shot',
      prompt: 'p',
      resultSchema: { type: 'object' },
    }),
    /turn exploded/,
  );
  assert.equal(orchestrator.resultSchemas.size, 0, 'the failure path must clean the schema map');
  // scheduleOneShot releases its capacity in a trailing finally.
  await new Promise((resolve) => setImmediate(resolve));
  db.close();
});

test('a successful one-shot removes its resultSchemas entry too', async () => {
  const { db, orchestrator, store } = fixture();
  addRun(store, 'run-ok');
  orchestrator.createRun = async () => ({ id: 'run-ok' });
  orchestrator.sendPrompt = async () => ({ turnId: 'turn-ok' });
  orchestrator.waitForTurn = () => Promise.resolve();
  orchestrator.finalAssistantMessage = async () => '{}';
  orchestrator.stopRun = async () => undefined;

  const { finalMessage } = await orchestrator.runOneShot({
    kind: 'analysis',
    title: 'one shot',
    prompt: 'p',
    resultSchema: { type: 'object' },
  });
  assert.equal(finalMessage, '{}');
  assert.equal(orchestrator.resultSchemas.size, 0);
  await new Promise((resolve) => setImmediate(resolve));
  db.close();
});
