import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { RefinementService } from '../dist/api/refinement-service.js';
import { RefinementStore } from '../dist/api/refinement-store.js';

function fixture(boardOverride = {}) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE refinements (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, repo TEXT NOT NULL, branch TEXT NOT NULL,
      title TEXT NOT NULL, story TEXT NOT NULL, status TEXT NOT NULL, error TEXT, method_id TEXT,
      spec_ids TEXT NOT NULL, doc_ids TEXT NOT NULL, summary TEXT, run_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE refine_items (
      id TEXT PRIMARY KEY, refinement_id TEXT NOT NULL, ord INTEGER NOT NULL,
      title TEXT NOT NULL, description TEXT NOT NULL, acceptance TEXT NOT NULL,
      priority INTEGER NOT NULL, depends_on TEXT NOT NULL, status TEXT NOT NULL,
      task_id TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE refine_methods (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
      description TEXT NOT NULL, instructions TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  const store = new RefinementStore(db);
  const now = Date.now();
  store.insert({ id: 'ref-1', workspaceId: 'ws-1', repo: 'owner/repo', branch: 'main', title: 'Feature', story: 'Story', status: 'ready', error: null, methodId: null, specIds: [], docIds: [], summary: null, runId: null, createdAt: now, updatedAt: now });
  store.replaceProposed('ref-1', [
    { id: 'a', refinementId: 'ref-1', ord: 0, title: 'A', description: 'A', acceptance: 'A', priority: 2, dependsOn: [], status: 'proposed', taskId: null, createdAt: now },
    { id: 'b', refinementId: 'ref-1', ord: 1, title: 'B', description: 'B', acceptance: 'B', priority: 2, dependsOn: [0], status: 'proposed', taskId: null, createdAt: now },
    { id: 'c', refinementId: 'ref-1', ord: 2, title: 'C', description: 'C', acceptance: 'C', priority: 2, dependsOn: [1], status: 'proposed', taskId: null, createdAt: now },
  ]);
  const board = { createTask: () => ({ id: 'tsk-default' }), addTaskDependencies() {}, ...boardOverride };
  const service = new RefinementService(store, { specs: { list: () => [] }, docs: { list: () => [], get: () => undefined } }, board, { repos: { get: () => ({ default_branch: 'main' }), inWorkspace: () => true } }, {}, {}, () => undefined);
  return { db, store, service };
}

test('reordering keeps dependencies attached to item identity', () => {
  const { db, service } = fixture();
  const moved = service.moveItem('ref-1', 'a', 'down');
  const byId = new Map(moved.map((item) => [item.id, item]));
  assert.equal(byId.get('b').ord, 0);
  assert.equal(byId.get('a').ord, 1);
  assert.deepEqual(byId.get('b').dependsOn, [1]);
  assert.deepEqual(byId.get('c').dependsOn, [0]);
  db.close();
});

test('merging rewrites dependents to the surviving item and imported items stay locked', () => {
  const { db, store, service } = fixture();
  const merged = service.mergeItems('ref-1', ['a', 'b']);
  const items = service.get('ref-1').items;
  assert.equal(merged.id, 'a');
  assert.equal(items.some((item) => item.id === 'b'), false);
  assert.deepEqual(items.find((item) => item.id === 'c').dependsOn, [merged.ord]);
  store.setItemStatus('a', 'imported', 'tsk-a');
  assert.throws(() => service.updateItem('ref-1', 'a', { title: 'Changed' }), /not proposed/);
  db.close();
});

test('partial queued import is retryable and never duplicates completed items', () => {
  const calls = [];
  let failOnce = true;
  const { db, service } = fixture({
    createTask(input) {
      calls.push({ title: input.title, queue: input.queue });
      if (input.title === 'B' && failOnce) { failOnce = false; throw new Error('temporary board failure'); }
      return { id: `tsk-${input.title}` };
    },
  });
  assert.throws(() => service.importAll('ref-1', 'alice', true, 'main'), /temporary/);
  assert.equal(service.get('ref-1').items.find((item) => item.id === 'a').status, 'imported');
  assert.equal(service.importAll('ref-1', 'alice', true, 'main'), 2);
  assert.deepEqual(calls.map((call) => call.title), ['A', 'B', 'B', 'C']);
  assert.ok(calls.every((call) => call.queue === true));
  assert.deepEqual(service.get('ref-1').items.map((item) => item.taskId), ['tsk-A', 'tsk-B', 'tsk-C']);
  db.close();
});
