import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import migrations from '../dist/api/migrations.js';
import { OperateStore } from '../dist/api/operate-store.js';

function seededStore() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  for (const m of migrations) m.up(db);
  return new OperateStore(db, {
    get: (key) => db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key)?.value ?? null,
    set: (key, value) => db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(key, value),
  });
}

function insertRun(store, id, status, kind = 'interactive') {
  const now = Date.now();
  store.runs.insert({
    id,
    kind,
    status,
    title: 'chat',
    cwd: '',
    repo: null,
    issueNumber: null,
    proposalId: null,
    branch: null,
    prUrl: null,
    model: null,
    price: null,
    runnerId: null,
    userId: 'ana',
    task: 'operate.chat',
    harness: 'moxxy',
    createdAt: now,
    updatedAt: now,
    inputTokens: 0,
    outputTokens: 0,
    outcome: null,
  });
}

test('the boot sweep interrupts idle chats so they stop holding scheduler slots', () => {
  const store = seededStore();
  // An attended chat sits in 'idle' between turns; its gateway died with the
  // daemon exactly like a running one's.
  insertRun(store, 'run-idle', 'idle');
  insertRun(store, 'run-running', 'running');
  insertRun(store, 'run-review', 'review');
  assert.equal(store.runs.activeInteractiveCount(), 3);
  assert.equal(store.runs.activeNonQueueCount(), 3);

  assert.equal(store.runs.markInterrupted(), 2);
  assert.equal(store.runs.get('run-idle').status, 'interrupted');
  assert.equal(store.runs.get('run-running').status, 'interrupted');
  // 'review' survives on purpose: the finished diff is still worth acting on.
  assert.equal(store.runs.get('run-review').status, 'review');
  assert.equal(store.runs.activeInteractiveCount(), 1);
  assert.equal(store.runs.activeNonQueueCount(), 1);
});
