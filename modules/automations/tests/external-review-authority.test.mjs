import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import { Automations } from '../dist/api/automations.js';
import { AutomationsStore } from '../dist/api/automations-store.js';
import migrations from '../dist/api/migrations.js';

/**
 * `approvalAtHead` decides whether an automated merge proceeds with no human
 * anywhere in the loop, so the cases below are the ones that would ship
 * unreviewed code rather than merely inconvenience someone.
 */
function fixture(reviews) {
  const db = new Database(':memory:');
  for (const migration of migrations) migration.up(db);
  const empty = {};
  const store = new AutomationsStore({
    db, repos: empty, issues: empty, prs: empty, runs: empty,
    workspaces: empty, reports: empty, settings: empty, notify: { emit() {} },
  });
  const client = {
    prReviewList: async () => {
      if (reviews === 'throw') throw new Error('502 bad gateway');
      return reviews;
    },
  };
  const automations = new Automations(
    store, {}, {}, {}, {}, {}, {}, {}, {}, {}, {},
    () => client, () => undefined, () => true, () => {}, () => {},
  );
  return { db, store, automations, client };
}

const review = (o) => ({
  user: { login: 'octopus-afterbrew[bot]' },
  state: 'APPROVED',
  submitted_at: '2026-08-26T12:00:00Z',
  commit_id: 'HEAD_SHA',
  ...o,
});

const ask = (automations, client) =>
  automations.approvalAtHead(client, 'acme/app', 7, 'octopus-afterbrew[bot]', 'HEAD_SHA');

test('an approval on the exact head merges', async () => {
  const { db, automations, client } = fixture([review()]);
  assert.equal(await ask(automations, client), true);
  db.close();
});

test('an approval of an EARLIER commit does not merge', async () => {
  // The failure this exists to stop. GitHub does not dismiss an approval when
  // new commits arrive unless branch protection says so, so `reviewDecision:
  // approved` routinely describes a commit that is no longer the head - and
  // merging on it ships code no reviewer ever saw.
  const { db, automations, client } = fixture([review({ commit_id: 'OLDER_SHA' })]);
  assert.equal(await ask(automations, client), false);
  db.close();
});

test('a later CHANGES_REQUESTED from the same reviewer revokes the approval', async () => {
  // Taking "some approval exists" would read this as approved.
  const { db, automations, client } = fixture([
    review({ submitted_at: '2026-08-26T12:00:00Z' }),
    review({ state: 'CHANGES_REQUESTED', submitted_at: '2026-08-26T13:00:00Z' }),
  ]);
  assert.equal(await ask(automations, client), false);
  db.close();
});

test('an approval after a CHANGES_REQUESTED does merge', async () => {
  const { db, automations, client } = fixture([
    review({ state: 'CHANGES_REQUESTED', submitted_at: '2026-08-26T12:00:00Z' }),
    review({ submitted_at: '2026-08-26T13:00:00Z' }),
  ]);
  assert.equal(await ask(automations, client), true);
  db.close();
});

test('somebody else approving is not the nominated reviewer approving', async () => {
  const { db, automations, client } = fixture([review({ user: { login: 'passer-by' } })]);
  assert.equal(await ask(automations, client), false);
  db.close();
});

test('a COMMENT review is not an approval', async () => {
  // Octopus posts COMMENT when it found something below the failure threshold.
  const { db, automations, client } = fixture([review({ state: 'COMMENTED' })]);
  assert.equal(await ask(automations, client), false);
  db.close();
});

test('an unreadable review list holds the merge rather than allowing it', async () => {
  // Not "unapproved" - unknown. Merging on a network failure is the one
  // outcome that cannot be taken back.
  const { db, automations, client } = fixture('throw');
  assert.equal(await ask(automations, client), false);
  db.close();
});

test('no reviews at all is not an approval', async () => {
  const { db, automations, client } = fixture([]);
  assert.equal(await ask(automations, client), false);
  db.close();
});

test('the reviewer login is matched case-insensitively', async () => {
  const { db, automations, client } = fixture([review({ user: { login: 'Octopus-AfterBrew[bot]' } })]);
  assert.equal(await ask(automations, client), true);
  db.close();
});

test('the merge authority round-trips and an omitted field preserves it', () => {
  const { db, store } = fixture([]);
  const base = {
    workspaceId: 'ws-1', repo: 'acme/app', mode: 'governed',
    actionableIssueKinds: ['bug'], queueIssues: true, autoApplyTriage: false,
    mergeMethod: 'squash', maxAttempts: 3, ownerId: 'alice', updatedAt: 1,
    admitLabel: 'agent:ready', externalReviewLogin: 'octopus-afterbrew[bot]',
  };
  store.setContributorFlow(base);
  assert.equal(store.contributorFlow('acme/app').externalReviewLogin, 'octopus-afterbrew[bot]');

  db.prepare(`UPDATE contributor_flows SET external_review_login = '' WHERE repo = ?`).run('acme/app');
  assert.equal(store.contributorFlow('acme/app').externalReviewLogin, null, 'empty must read as absent');
  db.close();
});
