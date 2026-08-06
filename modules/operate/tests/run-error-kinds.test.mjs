import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import migrations from '../dist/api/migrations.js';
import { OperateStore } from '../dist/api/operate-store.js';
import { Orchestrator } from '../dist/api/orchestrator.js';

process.env.COMPANION_HOME = mkdtempSync(join(tmpdir(), 'companion-run-error-kinds-'));

const CONFIG = { host: '127.0.0.1', port: 8903, maxLiveRuns: 3 };

/** The provider's own wording, which is all moxxy passes through. */
const OVERLOADED = 'Our servers are currently overloaded. Please try again later.';

function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  for (const m of migrations) m.up(db);
  const store = new OperateStore(db, {
    get: (key) => db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key)?.value ?? null,
    set: (key, value) => db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(key, value),
  });
  const broadcasts = [];
  return { db, store, broadcasts, orchestrator: new Orchestrator(store, CONFIG, {}, null, (m) => broadcasts.push(m)) };
}

function addRun(store, id) {
  const now = Date.now();
  store.runs.insert({
    id,
    kind: 'implement',
    status: 'running',
    title: 'board task',
    cwd: '/tmp',
    repo: 'owner/repo',
    issueNumber: null,
    proposalId: null,
    branch: null,
    prUrl: null,
    model: null,
    runnerId: null,
    userId: 'ana',
    task: null,
    harness: 'moxxy',
    createdAt: now,
    updatedAt: now,
    inputTokens: 0,
    outputTokens: 0,
    outcome: null,
  });
}

const errorEvent = (kind) => ({
  id: `e-${Math.random().toString(36).slice(2)}`,
  seq: 1,
  ts: Date.now(),
  sessionId: 's1',
  turnId: 't1',
  source: 'system',
  type: 'error',
  kind,
  message: OVERLOADED,
});

test('a retryable provider error leaves the run working', () => {
  const { db, store, orchestrator } = fixture();
  addRun(store, 'run-a');

  orchestrator.onEvent('run-a', errorEvent('retryable'));

  // moxxy is backing off and will try again; nothing about this run has failed.
  const row = store.runs.get('run-a');
  assert.equal(row.status, 'running');
  assert.equal(row.outcome, null, 'a retry must not be recorded as the run outcome');
  db.close();
});

test('a fatal provider error is recorded as the outcome of that run alone', () => {
  const { db, store, orchestrator } = fixture();
  // Two runs: with one, "the outcome landed on the right run" is
  // indistinguishable from "there was nowhere else for it to land".
  addRun(store, 'run-a');
  addRun(store, 'run-b');

  orchestrator.onEvent('run-b', errorEvent('fatal'));

  assert.equal(store.runs.get('run-b').outcome, `fatal: ${OVERLOADED}`);
  assert.equal(store.runs.get('run-a').outcome, null, 'the bystander run was not touched');
  db.close();
});

test('the transcript and the run record agree on what counts as dead', () => {
  const { db, store, orchestrator } = fixture();
  addRun(store, 'run-a');

  // Same rule the fold applies: an unrecognized kind is not a death. If these
  // two ever disagree, the transcript shows a corpse the board still schedules.
  for (const kind of ['retryable', 'tool_threw', 'hook_failed', 'provider_failed', 'some_future_kind', undefined]) {
    orchestrator.onEvent('run-a', errorEvent(kind));
    assert.equal(store.runs.get('run-a').outcome, null, `kind=${String(kind)} must not end the run`);
  }

  orchestrator.onEvent('run-a', errorEvent('fatal'));
  assert.ok(store.runs.get('run-a').outcome.startsWith('fatal: '));
  db.close();
});

test('every error event still reaches the transcript stream', () => {
  const { db, store, orchestrator, broadcasts } = fixture();
  addRun(store, 'run-a');

  orchestrator.onEvent('run-a', errorEvent('retryable'));

  // Downgrading the severity must not swallow the event: the operator still
  // needs to see that the provider faltered.
  const streamed = broadcasts.filter((m) => m.t === 'event' && m.runId === 'run-a');
  assert.equal(streamed.length, 1);
  assert.equal(streamed[0].event.kind, 'retryable');
  db.close();
});
