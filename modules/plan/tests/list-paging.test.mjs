import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import { DocsStore } from '../dist/api/docs-store.js';
import { SpecsStore } from '../dist/api/specs-store.js';

test('documentation list pages search full bodies without returning markdown', () => {
  const db = knowledgeDatabase();
  const store = new DocsStore(db, false);
  for (let index = 0; index < 123; index += 1) {
    store.insert(doc(index));
  }
  store.insert(doc(999, { workspaceId: 'another-workspace', content: 'needle-only-in-body' }));

  const page = store.listWorkspacePage('workspace-1', { limit: 20, offset: 40 });
  assert.equal(page.total, 123);
  assert.equal(page.docs.length, 20);
  assert.equal(page.docs[0].id, 'doc-082');
  assert.equal(page.docs.at(-1).id, 'doc-063');
  assert.equal(Object.hasOwn(page.docs[0], 'content'), false);

  const bodyMatch = store.listWorkspacePage('workspace-1', { q: 'needle-only-in-body' });
  assert.equal(bodyMatch.total, 1);
  assert.equal(bodyMatch.docs[0].id, 'doc-017');
  assert.equal(bodyMatch.docs[0].contentLength, doc(17).content.length);
  assert.equal(Object.hasOwn(bodyMatch.docs[0], 'content'), false);

  const workspaceWide = store.listWorkspacePage('workspace-1', { repo: null });
  assert.equal(workspaceWide.total, 1);
  assert.equal(workspaceWide.docs[0].id, 'doc-005');
  const importedRepoDocs = store.listWorkspacePage('workspace-1', {
    repo: 'owner/repo-b', source: 'imported', storage: 'repo',
  });
  assert.ok(importedRepoDocs.total > 0);
  assert.ok(importedRepoDocs.docs.every((record) =>
    record.repo === 'owner/repo-b' && record.source === 'imported' && record.storage === 'repo'));
  const options = store.listOptions('workspace-1', 'owner/repo-b');
  assert.ok(options.some((option) => option.id === 'doc-005'));
  assert.ok(options.length > 1);
  assert.deepEqual(Object.keys(options[0]).sort(), ['id', 'title']);
  db.close();
});

test('specification pages are bounded, workspace-scoped and support drift filtering', () => {
  const db = knowledgeDatabase();
  const store = new SpecsStore(db);
  for (let index = 0; index < 117; index += 1) {
    store.insert(spec(index));
  }
  store.insert(spec(999, { workspaceId: 'another-workspace', content: 'spec-body-marker' }));

  const page = store.listWorkspacePage('workspace-1', { limit: 17, offset: 100 });
  assert.equal(page.total, 117);
  assert.equal(page.specs.length, 17);
  assert.equal(page.specs[0].id, 'spec-016');
  assert.equal(page.specs.at(-1).id, 'spec-000');
  assert.ok(page.specs.every((record) => !Object.hasOwn(record, 'content')));

  const bodyMatch = store.listWorkspacePage('workspace-1', { q: 'spec-body-marker' });
  assert.equal(bodyMatch.total, 1);
  assert.equal(bodyMatch.specs[0].id, 'spec-023');
  assert.equal(bodyMatch.specs[0].contentLength, spec(23).content.length);

  const drifted = store.listWorkspacePage('workspace-1', { status: 'drifted' });
  assert.equal(drifted.total, 4);
  assert.ok(drifted.specs.every((record) => record.driftNote !== null));
  const readyManual = store.listWorkspacePage('workspace-1', {
    repo: 'owner/repo-a', status: 'ready', source: 'manual', storage: 'virtual', limit: 100,
  });
  assert.ok(readyManual.total > 0);
  assert.ok(readyManual.specs.every((record) =>
    record.repo === 'owner/repo-a' && record.status === 'ready'
      && record.source === 'manual' && record.storage === 'virtual'));
  const options = store.listReadyOptions('workspace-1', 'owner/repo-a');
  assert.ok(options.length > 0);
  assert.deepEqual(Object.keys(options[0]).sort(), ['id', 'title']);
  db.close();
});

function doc(index, overrides = {}) {
  const id = String(index).padStart(3, '0');
  return {
    id: `doc-${id}`,
    workspaceId: 'workspace-1',
    repo: index === 5 ? null : index % 2 === 0 ? 'owner/repo-a' : 'owner/repo-b',
    title: `Document ${id}`,
    content: index === 17 ? `${'x'.repeat(300_000)} needle-only-in-body` : `documentation body ${id}`,
    source: index % 2 === 0 ? 'manual' : 'imported',
    storage: index % 2 === 0 ? 'virtual' : 'repo',
    path: index % 2 === 0 ? null : `docs/${id}.md`,
    embedder: 'local-bm25',
    chunkCount: index % 4,
    createdAt: index,
    updatedAt: index,
    ...overrides,
  };
}

function spec(index, overrides = {}) {
  const id = String(index).padStart(3, '0');
  return {
    id: `spec-${id}`,
    workspaceId: 'workspace-1',
    repo: index % 2 === 0 ? 'owner/repo-a' : 'owner/repo-b',
    title: `Specification ${id}`,
    content: index === 23 ? `${'y'.repeat(200_000)} spec-body-marker` : `specification body ${id}`,
    status: index % 11 === 0 ? 'failed' : 'ready',
    source: index % 2 === 0 ? 'manual' : 'imported',
    storage: index % 2 === 0 ? 'virtual' : 'repo',
    path: index % 2 === 0 ? null : `specs/${id}.md`,
    generateRunId: null,
    driftNote: index % 30 === 0 ? `drift ${id}` : null,
    createdAt: index,
    updatedAt: index,
    ...overrides,
  };
}

function knowledgeDatabase() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE docs (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, repo TEXT, title TEXT NOT NULL,
      content TEXT NOT NULL, source TEXT NOT NULL, storage TEXT NOT NULL, path TEXT,
      embedder TEXT NOT NULL, chunk_count INTEGER NOT NULL, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE specs (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, repo TEXT NOT NULL, title TEXT NOT NULL,
      content TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL, storage TEXT NOT NULL,
      path TEXT, generate_run_id TEXT, drift_note TEXT, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  return db;
}
