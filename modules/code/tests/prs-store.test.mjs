import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import { GitHubSync } from '../dist/api/github-sync.js';
import migrations from '../dist/api/migrations.js';
import { PrReviewsStore } from '../dist/api/pr-reviews-store.js';
import { PrsStore } from '../dist/api/prs-store.js';

function fixture() {
  const db = new Database(':memory:');
  for (const migration of migrations) migration.up(db);
  const prs = new PrsStore(db, new PrReviewsStore(db), { logins: () => [] });
  return { db, prs, sync: new GitHubSync({ prs }, () => null, () => undefined) };
}

/** A pull request as the list feed and the webhook delivery both carry it. */
const pull = {
  number: 7,
  title: 'Add the widget',
  body: 'closes #3',
  state: 'open',
  merged_at: null,
  draft: true,
  head: { ref: 'feat/widget', sha: 'abc123' },
  base: { ref: 'main' },
  user: { login: 'contributor' },
  labels: [{ name: 'enhancement' }],
  assignees: [{ login: 'maintainer' }],
  html_url: 'https://github.com/acme/app/pull/7',
  created_at: '2026-07-01T10:00:00Z',
  updated_at: '2026-07-02T10:00:00Z',
  closed_at: null,
};

// The bind object is named field by field: every key it carries has to be a
// parameter the INSERT declares, or the driver rejects the whole statement and
// the repo's sync fails as if GitHub had refused it.
test('a synced pull request lands in the cache with the fields the feed carries', () => {
  const { prs, sync } = fixture();

  sync.applyPull('acme/app', pull);

  assert.deepEqual(prs.get('acme/app', 7), {
    repo: 'acme/app',
    number: 7,
    title: 'Add the widget',
    body: 'closes #3',
    state: 'open',
    headRef: 'feat/widget',
    headSha: 'abc123',
    baseRef: 'main',
    draft: true,
    author: 'contributor',
    labels: ['enhancement'],
    assignees: ['maintainer'],
    comments: 0,
    url: 'https://github.com/acme/app/pull/7',
    createdAt: Date.parse('2026-07-01T10:00:00Z'),
    updatedAt: Date.parse('2026-07-02T10:00:00Z'),
    closedAt: null,
    review: null,
    reviewRisk: null,
    reviewDecision: null,
    mergeable: null,
    // The list feed carries neither, and a PR nobody has asked GitHub about yet
    // has no merge state — null is "not fetched", not "cannot merge".
    mergeStateStatus: null,
    checks: null,
  });
});

test('re-syncing the same pull request updates it in place', () => {
  const { prs, sync } = fixture();

  sync.applyPull('acme/app', pull);
  sync.applyPull('acme/app', { ...pull, draft: false, title: 'Add the widget, properly', merged_at: null });

  assert.equal(prs.list('acme/app').length, 1);
  assert.equal(prs.get('acme/app', 7).draft, false);
  assert.equal(prs.get('acme/app', 7).title, 'Add the widget, properly');
});

test('the scheduler view decorates only open pull requests', () => {
  const { prs, sync } = fixture();
  sync.applyPull('acme/app', { ...pull, number: 7, draft: false });
  sync.applyPull('acme/app', {
    ...pull,
    number: 8,
    state: 'closed',
    draft: false,
    closed_at: '2026-07-03T10:00:00Z',
  });

  assert.deepEqual(prs.listOpen('acme/app').map((pr) => pr.number), [7]);
});

test('a workspace scheduler query excludes closed history in SQL', () => {
  const { db, prs, sync } = fixture();
  db.prepare(
    `INSERT INTO repos (full_name, owner, name, default_branch, private, workspace_id)
     VALUES (?, ?, ?, 'main', 0, ?)`,
  ).run('acme/app', 'acme', 'app', 'ws-1');
  db.prepare(`INSERT INTO repo_workspaces (repo, workspace_id, created_at) VALUES (?, ?, 0)`).run(
    'acme/app',
    'ws-1',
  );
  sync.applyPull('acme/app', { ...pull, number: 7, draft: false });
  sync.applyPull('acme/app', {
    ...pull,
    number: 8,
    state: 'closed',
    draft: false,
    closed_at: '2026-07-03T10:00:00Z',
  });

  assert.deepEqual(prs.listWorkspace('ws-1', 'open').map((pr) => pr.number), [7]);
});

test('a push clears the review decision, like it already clears the checks', () => {
  // rayf#307: Octopus requested changes on one commit, the agent fixed it and pushed, and
  // the stored decision still said changes_requested. The board read it, bound the card
  // back to remediation for work already done, and burned its attempt budget doing so.
  const { prs, sync } = fixture();
  sync.applyPull('acme/app', pull);
  prs.setReviewDecision('acme/app', 7, 'changes_requested');
  prs.setChecks('acme/app', 7, { state: 'passing', total: 1, passed: 1, failed: 0, pending: 0, fetchedAt: 1 });

  assert.equal(prs.get('acme/app', 7).reviewDecision, 'changes_requested');

  sync.applyPull('acme/app', { ...pull, head: { ref: 'feat/widget', sha: 'def456' } });

  const after = prs.get('acme/app', 7);
  assert.equal(after.reviewDecision, null, 'a decision about the old commit is not one about this one');
  assert.equal(after.checks, null, 'checks were already invalidated; the decision now follows the same rule');
});

test('a sync that does not move the head keeps the decision', () => {
  // The decision is expensive to re-establish - it waits on a human or a bot reviewer -
  // so an ordinary re-sync must not discard it.
  const { prs, sync } = fixture();
  sync.applyPull('acme/app', pull);
  prs.setReviewDecision('acme/app', 7, 'approved');

  sync.applyPull('acme/app', { ...pull, title: 'Add the widget, renamed' });

  assert.equal(prs.get('acme/app', 7).reviewDecision, 'approved');
});
