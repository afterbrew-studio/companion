import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import migrations from '../dist/api/migrations.js';
import { RefinementStore } from '../dist/api/refinement-store.js';

test('refinement cards are paged and never materialise epic or summary bodies', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE repos (full_name TEXT PRIMARY KEY, workspace_id TEXT);
    CREATE TABLE repo_workspaces (repo TEXT NOT NULL, workspace_id TEXT NOT NULL, created_at INTEGER NOT NULL);
  `);
  for (const migration of migrations) migration.up(db);
  const store = new RefinementStore(db);

  for (let index = 0; index < 125; index += 1) {
    store.insert({
      id: `ref-${String(index).padStart(3, '0')}`,
      workspaceId: 'ws-1',
      repo: index % 2 === 0 ? 'acme/app' : 'acme/api',
      branch: 'main',
      title: `Refinement ${index}`,
      story: index === 42 ? `${'x'.repeat(31_000)} epic-only-marker` : 'x'.repeat(31_000),
      status: index % 3 === 0 ? 'ready' : 'draft',
      error: null,
      methodId: null,
      specIds: [],
      docIds: [],
      summary: 'y'.repeat(50_000),
      runId: null,
      createdAt: index,
      updatedAt: index,
    });
  }
  store.insert({
    id: 'ref-other', workspaceId: 'ws-2', repo: 'other/private', branch: 'main', title: 'Invisible',
    story: 'hidden', status: 'draft', error: null, methodId: null, specIds: [], docIds: [], summary: null,
    runId: null, createdAt: 999, updatedAt: 999,
  });
  store.replaceProposed('ref-124', [{
    id: 'item-1', refinementId: 'ref-124', ord: 0, title: 'First task', description: 'Description',
    acceptance: 'Acceptance', priority: 1, dependsOn: [], status: 'proposed', taskId: null, createdAt: 1,
  }]);

  const first = store.listWorkspacePage('ws-1', { limit: 5_000, offset: -10 });
  assert.equal(first.total, 125);
  assert.equal(first.refinements.length, 100);
  assert.equal(first.refinements[0].id, 'ref-124');
  assert.equal(first.refinements[0].proposedCount, 1);
  assert.equal(Object.hasOwn(first.refinements[0], 'story'), false);
  assert.equal(Object.hasOwn(first.refinements[0], 'summary'), false);

  const search = store.listWorkspacePage('ws-1', { q: 'epic-only-marker' });
  assert.equal(search.total, 1);
  assert.equal(search.refinements[0].id, 'ref-042');
  const ready = store.listWorkspacePage('ws-1', { repo: 'acme/app', status: 'ready' });
  assert.ok(ready.total > 0);
  assert.ok(ready.refinements.every((entry) => entry.repo === 'acme/app' && entry.status === 'ready'));
  db.close();
});
