import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { ReposStore } from '../dist/api/repos-store.js';

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE repos (
      full_name TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL,
      default_branch TEXT NOT NULL, private INTEGER NOT NULL,
      workspace_id TEXT, github_account_id TEXT, runner_id TEXT,
      clone_ready INTEGER NOT NULL DEFAULT 0, last_sync_at INTEGER,
      auto_triage INTEGER NOT NULL DEFAULT 0, digest_enabled INTEGER NOT NULL DEFAULT 0,
      stale_enabled INTEGER NOT NULL DEFAULT 0, pr_gate INTEGER NOT NULL DEFAULT 0,
      auto_merge INTEGER NOT NULL DEFAULT 0, webhook_secret TEXT,
      webhook_owner_id TEXT, webhook_account_id TEXT, automation_owner_id TEXT
    );
    CREATE TABLE repo_workspaces (
      repo TEXT NOT NULL, workspace_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (repo, workspace_id)
    );
    CREATE TABLE issues (repo TEXT NOT NULL);
    CREATE TABLE prs (repo TEXT NOT NULL);
  `);
  return { db, repos: new ReposStore(db, { ensureDefault() {} }) };
}

test('one repository can belong to multiple workspaces without duplicating its cache', () => {
  const { db, repos } = fixture();
  const input = {
    fullName: 'moxxy-ai/companion',
    owner: 'moxxy-ai',
    name: 'companion',
    defaultBranch: 'main',
    private: true,
  };

  repos.upsert({ ...input, workspaceId: 'ws-a' });
  repos.upsert({ ...input, workspaceId: 'ws-b' });
  db.prepare(`INSERT INTO issues (repo) VALUES (?)`).run(input.fullName);
  db.prepare(`INSERT INTO prs (repo) VALUES (?)`).run(input.fullName);

  assert.equal(repos.list().length, 1);
  assert.equal(repos.listByWorkspace('ws-a').length, 1);
  assert.equal(repos.listByWorkspace('ws-b').length, 1);
  assert.equal(repos.listAccessible(['ws-b'])[0]?.workspace_id, 'ws-b');
  assert.deepEqual(repos.workspaceIds(input.fullName), ['ws-a', 'ws-b']);

  repos.removeFromWorkspace(input.fullName, 'ws-a');
  assert.equal(repos.inWorkspace(input.fullName, 'ws-a'), false);
  assert.equal(repos.inWorkspace(input.fullName, 'ws-b'), true);
  assert.ok(repos.get(input.fullName));
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM issues`).get().n, 1);

  repos.removeFromWorkspace(input.fullName, 'ws-b');
  assert.equal(repos.get(input.fullName), undefined);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM issues`).get().n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM prs`).get().n, 0);
});

test('adding the same repository twice to one workspace is idempotent at the store boundary', () => {
  const { repos } = fixture();
  const input = {
    fullName: 'moxxy-ai/companion',
    owner: 'moxxy-ai',
    name: 'companion',
    defaultBranch: 'main',
    private: false,
    workspaceId: 'ws-a',
  };

  repos.upsert(input);
  repos.upsert(input);

  assert.equal(repos.listByWorkspace('ws-a').length, 1);
  assert.deepEqual(repos.workspaceIds(input.fullName), ['ws-a']);
});

test('webhook registration has one personal owner and disconnecting its account disables it', () => {
  const { repos } = fixture();
  repos.upsert({
    fullName: 'acme/private',
    owner: 'acme',
    name: 'private',
    defaultBranch: 'main',
    private: true,
    workspaceId: 'ws-a',
  });

  repos.setWebhookRegistration('acme/private', 'secret', 'alice', 'gha-alice');
  assert.deepEqual(repos.getWebhookRegistration('acme/private'), {
    secret: 'secret',
    ownerId: 'alice',
    accountId: 'gha-alice',
  });

  repos.orphanWebhookRegistrationsForAccount('gha-alice');
  assert.equal(repos.getWebhookRegistration('acme/private'), null);
  assert.equal(repos.getRecord('acme/private').webhookConfigured, false);
});
