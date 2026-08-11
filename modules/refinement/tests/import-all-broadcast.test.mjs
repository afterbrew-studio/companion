import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import { RefinementService } from '../dist/api/refinement-service.js';
import { RefinementStore } from '../dist/api/refinement-store.js';

/**
 * importAll imports in build order and a mid-loop failure surfaces to the
 * caller, but the items that DID import must still broadcast; otherwise
 * every other client keeps showing them as proposed.
 */
function fixture(board) {
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
  const broadcasts = [];
  const service = new RefinementService(
    store,
    { specs: { list: () => [] }, docs: { list: () => [], get: () => undefined } },
    board,
    { repos: { get: () => ({ default_branch: 'main' }), inWorkspace: () => true } },
    {},
    {},
    (msg) => broadcasts.push(msg),
  );
  return { db, store, service, broadcasts };
}

test('a mid-loop import failure still broadcasts the items already imported', () => {
  let created = 0;
  const board = {
    createTask: () => {
      created += 1;
      if (created === 3) throw new Error('board rejected the task');
      return { id: `tsk-${created}` };
    },
    addTaskDependencies() {},
  };
  const { db, store, service, broadcasts } = fixture(board);

  assert.throws(() => service.importAll('ref-1', 'alice', false), /board rejected/);
  const items = store.listItems('ref-1');
  assert.deepEqual(items.map((item) => item.status), ['imported', 'imported', 'proposed']);
  assert.ok(broadcasts.length > 0, 'partial progress must broadcast');
  db.close();
});

test('a fully successful importAll still broadcasts once at the end', () => {
  let created = 0;
  const board = {
    createTask: () => ({ id: `tsk-${(created += 1)}` }),
    addTaskDependencies() {},
  };
  const { db, store, service, broadcasts } = fixture(board);

  assert.equal(service.importAll('ref-1', 'alice', false), 3);
  assert.ok(store.listItems('ref-1').every((item) => item.status === 'imported'));
  assert.ok(broadcasts.length > 0);
  db.close();
});
