import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import migrations from '../dist/api/migrations.js';
import { RunsStore } from '../dist/api/runs-store.js';

const DAY = 24 * 60 * 60_000;
const OLD = Date.now() - 400 * DAY;

function fixture() {
  const db = new Database(':memory:');
  for (const m of migrations) m.up(db);
  return { db, store: new RunsStore(db) };
}

function seedRun(db, id, status, createdAt) {
  db.prepare(
    `INSERT INTO runs (id, kind, status, title, cwd, created_at, updated_at)
     VALUES (?, 'fix', ?, 'title', '/tmp', ?, ?)`,
  ).run(id, status, createdAt, createdAt);
}

test('run prune deletes only terminal rows older than the bound', () => {
  const { db, store } = fixture();
  seedRun(db, 'run-old-completed', 'completed', OLD);
  seedRun(db, 'run-old-failed', 'failed', OLD);
  seedRun(db, 'run-old-review', 'review', OLD);
  seedRun(db, 'run-old-running', 'running', OLD);
  seedRun(db, 'run-old-queued', 'queued', OLD);
  seedRun(db, 'run-fresh-completed', 'completed', Date.now());

  const removed = store.pruneTerminal(365 * DAY);
  assert.equal(removed, 2);
  const ids = db.prepare(`SELECT id FROM runs ORDER BY id`).all().map((r) => r.id);
  assert.deepEqual(ids, ['run-fresh-completed', 'run-old-queued', 'run-old-review', 'run-old-running']);
  db.close();
});

test('run prune is bounded per sweep and converges across runs', () => {
  const { db, store } = fixture();
  for (let i = 0; i < 5; i += 1) seedRun(db, `run-${i}`, 'completed', OLD + i);

  assert.equal(store.pruneTerminal(365 * DAY, 2), 2);
  assert.equal(store.pruneTerminal(365 * DAY, 2), 2);
  assert.equal(store.pruneTerminal(365 * DAY, 2), 1);
  assert.equal(store.pruneTerminal(365 * DAY, 2), 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM runs`).get().n, 0);
  db.close();
});
