import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import { IssuesStore } from '../dist/api/issues-store.js';
import migrations from '../dist/api/migrations.js';
import { PrReviewsStore } from '../dist/api/pr-reviews-store.js';
import { PrsStore } from '../dist/api/prs-store.js';
import { TriageStore } from '../dist/api/triage-store.js';

test('maintainer queues are bounded, scoped, counted, and body-free', () => {
  const db = new Database(':memory:');
  for (const migration of migrations) migration.up(db);
  db.prepare(
    `INSERT INTO repos (full_name, owner, name, default_branch, private, workspace_id)
     VALUES (?, ?, ?, 'main', 0, ?)`,
  ).run('acme/app', 'acme', 'app', 'ws-1');
  db.prepare(
    `INSERT INTO repos (full_name, owner, name, default_branch, private, workspace_id)
     VALUES (?, ?, ?, 'main', 0, ?)`,
  ).run('other/private', 'other', 'private', 'ws-2');
  db.prepare(`INSERT INTO repo_workspaces (repo, workspace_id, created_at) VALUES (?, ?, 0)`).run('acme/app', 'ws-1');
  db.prepare(`INSERT INTO repo_workspaces (repo, workspace_id, created_at) VALUES (?, ?, 0)`).run('other/private', 'ws-2');

  const accounts = { logins: () => [] };
  const triage = new TriageStore(db);
  const issues = new IssuesStore(db, triage, accounts);
  const prs = new PrsStore(db, new PrReviewsStore(db), accounts);
  const body = 'large description '.repeat(4_000);

  for (let index = 1; index <= 125; index += 1) {
    issues.upsert({
      repo: 'acme/app',
      number: index,
      title: `Issue ${index}`,
      body,
      state: 'open',
      labels: index % 2 === 0 ? ['bug'] : [],
      author: `author-${index % 4}`,
      assignees: [],
      comments: index,
      url: `https://example.invalid/issues/${index}`,
      createdAt: index,
      updatedAt: index,
      closedAt: null,
    });
    prs.upsert({
      repo: 'acme/app',
      number: index,
      title: `Pull request ${index}`,
      body,
      state: 'open',
      headRef: `feature-${index}`,
      headSha: `sha-${index}`,
      baseRef: 'main',
      draft: false,
      author: `author-${index % 4}`,
      labels: index % 2 === 0 ? ['enhancement'] : [],
      assignees: [],
      comments: 0,
      url: `https://example.invalid/pulls/${index}`,
      createdAt: index,
      updatedAt: index,
      closedAt: null,
    });
  }
  issues.upsert({
    repo: 'other/private', number: 999, title: 'Invisible', body, state: 'open', labels: [], author: 'other',
    assignees: [], comments: 0, url: 'https://example.invalid/issues/999', createdAt: 999, updatedAt: 999,
    closedAt: null,
  });
  prs.upsert({
    repo: 'other/private', number: 999, title: 'Invisible', body, state: 'open', headRef: 'hidden', headSha: 'hidden',
    baseRef: 'main', draft: false, author: 'other', labels: [], assignees: [], comments: 0,
    url: 'https://example.invalid/pulls/999', createdAt: 999, updatedAt: 999, closedAt: null,
  });
  triage.insert({
    id: 'triage-old', repo: 'acme/app', issueNumber: 125, runId: 'run-old', status: 'dismissed', verdict: null,
    error: null, createdAt: 1,
  });
  triage.insert({
    id: 'triage-new', repo: 'acme/app', issueNumber: 125, runId: 'run-new', status: 'pending', verdict: null,
    error: null, createdAt: 2,
  });

  const issuePage = issues.listWorkspacePaged('ws-1', 'open', { limit: 10_000, offset: -1 });
  assert.equal(issuePage.total, 125);
  assert.equal(issuePage.issues.length, 100);
  assert.equal(issuePage.issues[0].number, 125);
  assert.equal(issuePage.issues[0].triage, 'pending');
  assert.equal(Object.hasOwn(issuePage.issues[0], 'body'), false);
  assert.equal(issues.count('acme/app', 'open'), 125);
  assert.deepEqual([...triage.latestByIssue('acme/app', [125])], [[125, 'pending']]);

  const prPage = prs.listWorkspacePaged('ws-1', 'open', { limit: 10_000, offset: -1 });
  assert.equal(prPage.total, 125);
  assert.equal(prPage.prs.length, 100);
  assert.equal(prPage.prs[0].number, 125);
  assert.equal(Object.hasOwn(prPage.prs[0], 'body'), false);
  assert.ok(issuePage.issues.every((issue) => issue.repo === 'acme/app'));
  assert.ok(prPage.prs.every((pr) => pr.repo === 'acme/app'));
  db.close();
});
