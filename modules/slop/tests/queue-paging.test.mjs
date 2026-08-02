import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import migrations from '../dist/api/migrations.js';
import { SlopStore } from '../dist/api/slop-store.js';

test('contribution assessments page, search, filter, and respect visible repositories', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE v_repos (full_name TEXT NOT NULL, workspace_id TEXT NOT NULL)`);
  for (const migration of migrations) migration.up(db);
  db.prepare(`INSERT INTO v_repos (full_name, workspace_id) VALUES (?, ?)`).run('acme/app', 'ws-1');
  db.prepare(`INSERT INTO v_repos (full_name, workspace_id) VALUES (?, ?)`).run('acme/private', 'ws-1');
  db.prepare(`INSERT INTO v_repos (full_name, workspace_id) VALUES (?, ?)`).run('other/repo', 'ws-2');
  const store = new SlopStore(db);

  for (let index = 0; index < 125; index += 1) {
    store.insertDetection({
      id: `slop-${String(index).padStart(3, '0')}`,
      repo: index === 31 ? 'acme/private' : 'acme/app',
      prNumber: index + 1,
      prTitle: index === 42 ? 'Unique body-free queue marker' : `Pull request ${index + 1}`,
      runId: `run-${index}`,
      status: 'pending',
      verdict: {
        qualityClass: index % 2 === 0 ? 'unsafe' : 'valuable',
      },
      error: null,
      appliedAction: null,
      ruleIds: [],
      provenance: null,
      createdAt: index,
    });
  }

  const first = store.listByWorkspacePage('ws-1', {
    limit: 5_000,
    offset: -20,
    accessibleRepos: ['acme/app'],
  });
  assert.equal(first.total, 124);
  assert.equal(first.detections.length, 100);
  assert.ok(first.detections.every((detection) => detection.repo === 'acme/app'));

  const second = store.listByWorkspacePage('ws-1', {
    limit: 100,
    offset: 100,
    accessibleRepos: ['acme/app'],
  });
  assert.equal(second.detections.length, 24);
  const search = store.listByWorkspacePage('ws-1', { q: 'queue marker', accessibleRepos: ['acme/app'] });
  assert.equal(search.total, 1);
  assert.equal(search.detections[0].prNumber, 43);
  const unsafe = store.listByWorkspacePage('ws-1', { quality: 'unsafe', accessibleRepos: ['acme/app'] });
  assert.equal(unsafe.total, 63);
  assert.ok(unsafe.detections.every((detection) => detection.verdict?.qualityClass === 'unsafe'));
  db.close();
});
