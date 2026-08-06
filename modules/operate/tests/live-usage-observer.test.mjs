import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import migrations from '../dist/api/migrations.js';
import { OperateStore } from '../dist/api/operate-store.js';
import { Orchestrator } from '../dist/api/orchestrator.js';

process.env.COMPANION_HOME = mkdtempSync(join(tmpdir(), 'companion-live-usage-'));

const CONFIG = { host: '127.0.0.1', port: 8903, maxLiveRuns: 3 };

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
    title: 'review chunk',
    cwd: '/tmp',
    repo: 'owner/repo',
    issueNumber: 12,
    proposalId: null,
    branch: null,
    prUrl: null,
    model: 'claude-sonnet-4-6',
    runnerId: null,
    userId: 'ana',
    task: 'code.pr-review',
    harness: 'moxxy',
    createdAt: now,
    updatedAt: now,
    inputTokens: 0,
    outputTokens: 0,
    outcome: null,
  });
}

function usageEvent(seq, inputTokens, outputTokens) {
  return {
    id: `usage-${seq}`,
    seq,
    ts: Date.now(),
    sessionId: 'session-live',
    turnId: 'turn-live',
    source: 'provider',
    type: 'provider_response',
    inputTokens,
    outputTokens,
  };
}

test('one-shot usage observers see persisted cumulative rows and detach after completion', async () => {
  const { db, store, orchestrator } = fixture();
  addRun(store, 'run-live');

  let finishTurn;
  const turn = new Promise((resolve) => { finishTurn = resolve; });
  orchestrator.createRun = async () => ({ id: 'run-live' });
  orchestrator.waitForTurn = () => turn;
  orchestrator.sendPrompt = async () => ({ turnId: 'turn-live' });
  orchestrator.finalAssistantMessage = async () => '{}';
  orchestrator.stopRun = async () => undefined;

  const snapshots = [];
  let started = false;
  const result = orchestrator.runOneShot({
    kind: 'analysis',
    title: 'review chunk',
    prompt: 'review',
    onStarted: () => { started = true; },
    onUsage: (runId) => {
      const row = store.runs.get(runId);
      snapshots.push([row.input_tokens, row.output_tokens]);
    },
  });
  for (let attempt = 0; attempt < 10 && !started; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(started, true);

  orchestrator.onEvent('run-live', usageEvent(1, 100, 10));
  orchestrator.onEvent('run-live', usageEvent(2, 25, 5));
  assert.deepEqual(snapshots, [[100, 10], [125, 15]]);

  finishTurn();
  await result;
  // scheduleOneShot releases its capacity in the promise's trailing finally,
  // just after the caller-visible result settles.
  await new Promise((resolve) => setImmediate(resolve));
  orchestrator.onEvent('run-live', usageEvent(3, 1, 1));
  assert.deepEqual(snapshots, [[100, 10], [125, 15]], 'completed observers must not leak');
  assert.equal(store.runs.get('run-live').input_tokens, 126);
  db.close();
});

test('a broken live-usage observer aborts the turn instead of spending blind', async () => {
  const { db, store, orchestrator } = fixture();
  addRun(store, 'run-blind');

  let finishTurn;
  const turn = new Promise((resolve) => { finishTurn = resolve; });
  let started = false;
  let aborts = 0;
  orchestrator.createRun = async () => ({ id: 'run-blind' });
  orchestrator.waitForTurn = () => turn;
  orchestrator.sendPrompt = async () => ({ turnId: 'turn-blind' });
  orchestrator.finalAssistantMessage = async () => '{}';
  orchestrator.stopRun = async () => undefined;
  orchestrator.abortTurn = async () => { aborts += 1; };

  const result = orchestrator.runOneShot({
    kind: 'analysis',
    title: 'review chunk',
    prompt: 'review',
    onStarted: () => { started = true; },
    onUsage: () => { throw new Error('aggregate store unavailable'); },
  });
  for (let attempt = 0; attempt < 10 && !started; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  orchestrator.onEvent('run-blind', usageEvent(1, 100, 10));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(aborts, 1);
  assert.equal(store.runs.get('run-blind').outcome, 'aborted: live usage accounting failed');

  finishTurn();
  await result;
  await new Promise((resolve) => setImmediate(resolve));
  db.close();
});
