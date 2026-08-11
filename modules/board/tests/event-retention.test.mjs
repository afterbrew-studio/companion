import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import { BoardStore } from '../dist/api/board-store.js';

// Spelled out like fixture.mjs: the real migrations join code-owned tables.
function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE board_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, at INTEGER NOT NULL,
      kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX idx_board_events_task ON board_events(task_id, at);
  `);
  return { db, store: new BoardStore(db) };
}

test('event prune keeps the newest N per task and leaves small trails alone', () => {
  const { db, store } = fixture();
  for (let i = 0; i < 30; i += 1) store.insertEvent('task-big', 'tick', `detail-${i}`);
  for (let i = 0; i < 5; i += 1) store.insertEvent('task-small', 'tick', `detail-${i}`);
  // Deterministic recency: id breaks the tie when at is equal.
  const removed = store.pruneEvents(10);
  assert.equal(removed, 20);

  const big = store.listEvents('task-big', 100);
  assert.equal(big.length, 10);
  assert.deepEqual(
    big.map((e) => e.detail),
    Array.from({ length: 10 }, (_, i) => `detail-${29 - i}`),
  );
  assert.equal(store.listEvents('task-small', 100).length, 5);
  db.close();
});

test('event prune is bounded per sweep and converges across runs', () => {
  const { db, store } = fixture();
  for (let i = 0; i < 12; i += 1) store.insertEvent('task', 'tick', String(i));

  assert.equal(store.pruneEvents(2, 4), 4);
  assert.equal(store.pruneEvents(2, 4), 4);
  assert.equal(store.pruneEvents(2, 4), 2);
  assert.equal(store.pruneEvents(2, 4), 0);
  assert.deepEqual(store.listEvents('task', 100).map((e) => e.detail), ['11', '10']);
  db.close();
});
