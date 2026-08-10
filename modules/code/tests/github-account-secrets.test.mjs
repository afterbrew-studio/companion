import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import { GithubAccountsStore } from '../dist/api/github-accounts-store.js';

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE github_accounts (
      id TEXT PRIMARY KEY, login TEXT NOT NULL, token TEXT NOT NULL,
      purposes TEXT NOT NULL DEFAULT '[]', scope TEXT NOT NULL DEFAULT 'all',
      owner_id TEXT, created_at INTEGER NOT NULL, kind TEXT NOT NULL DEFAULT 'pat',
      app_id TEXT, installation_id TEXT, private_key TEXT, token_expires_at INTEGER,
      token_health TEXT, token_error TEXT
    );
    CREATE TABLE github_account_workspaces (
      account_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
      PRIMARY KEY (account_id, workspace_id)
    );
    CREATE TABLE repo_account_bindings (
      repo TEXT NOT NULL, owner_id TEXT NOT NULL, account_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (repo, owner_id)
    );
  `);
  const values = new Map();
  const secrets = {
    get: (key) => values.get(key) ?? null,
    set: (key, value) => values.set(key, value),
    delete: (key) => values.delete(key),
  };
  return { db, values, secrets };
}

test('GitHub credentials leave legacy rows and all later writes use SecretStore', () => {
  const { db, values, secrets } = fixture();
  db.prepare(
    `INSERT INTO github_accounts
       (id, login, token, purposes, scope, owner_id, created_at, kind, private_key)
     VALUES (?, ?, ?, '[]', 'all', ?, 1, 'app', ?)`,
  ).run('gha-old', 'alice', 'github_pat_plaintext', 'alice', 'pem-plaintext');

  const store = new GithubAccountsStore(db, secrets);
  assert.equal(store.list()[0].token, 'github_pat_plaintext');
  assert.equal(store.list()[0].privateKey, 'pem-plaintext');
  const migrated = db.prepare(`SELECT token, private_key FROM github_accounts WHERE id = 'gha-old'`).get();
  assert.doesNotMatch(`${migrated.token} ${migrated.private_key}`, /plaintext|github_pat/);

  store.setInstallationToken('gha-old', 'ghs_rotated', 1234);
  assert.equal(store.list()[0].token, 'ghs_rotated');
  assert.equal(db.prepare(`SELECT token FROM github_accounts WHERE id = 'gha-old'`).get().token, migrated.token);

  store.delete('gha-old');
  assert.equal([...values.keys()].some((key) => key.includes('gha-old')), false);
});
