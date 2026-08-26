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
    db,
    repos: {
      get: () => ({ full_name: 'acme/app' }),
      inWorkspace: () => true,
      getWebhookRegistration: () => ({ ownerId: 'alice', remoteId: 'wh-1', remoteError: null }),
    },
    issues: empty, prs: empty, runs: empty,
    workspaces: empty, reports: empty, settings: empty, notify: { emit() {} },
  });
  const client = {
    prReviewList: async () => {
      if (reviews === 'throw') throw new Error('502 bad gateway');
      if (reviews === 'truncated') return { reviews: [review()], truncated: true };
      return { reviews, truncated: false };
    },
  };
  const automations = new Automations(
    store, {}, {}, {}, {}, {}, {}, {}, {}, {}, {},
    () => client,
    () => ({ ensureAutomationWorkers() {}, tightenIssueAutomation: () => 0 }),
    () => true, () => {}, () => {},
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

const verdict = (automations, client) =>
  automations.externalVerdict(client, 'acme/app', 7, 'octopus-afterbrew[bot]', 'HEAD_SHA');
const ask = async (automations, client) => (await verdict(automations, client)).approved;

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

test('an omitted merge authority preserves the stored one', () => {
  // The case that matters: a client that predates this control sends every
  // other field and not this one. Previously this test SET the field and then
  // hand-edited the row, so deleting the preserve branch would not have failed
  // it - it never exercised the branch at all.
  const { db, store, automations } = fixture([]);
  const base = {
    workspaceId: 'ws-1', repo: 'acme/app', mode: 'governed',
    actionableIssueKinds: ['bug'], queueIssues: true, autoApplyTriage: false,
    mergeMethod: 'squash', maxAttempts: 3, ownerId: 'alice', updatedAt: 1,
    admitLabel: 'agent:ready', externalReviewLogin: 'octopus-afterbrew[bot]',
  };
  store.setContributorFlow(base);

  const { externalReviewLogin: _omitted, ...withoutIt } = base;
  automations.setContributorFlow({ ...withoutIt, maxAttempts: 7, updatedAt: 2 });

  const saved = store.contributorFlow('acme/app');
  assert.equal(saved.externalReviewLogin, 'octopus-afterbrew[bot]', 'omitting the field cleared the authority');
  assert.equal(saved.maxAttempts, 7, 'the rest of the save did not take');

  automations.setContributorFlow({ ...base, externalReviewLogin: null, updatedAt: 3 });
  assert.equal(store.contributorFlow('acme/app').externalReviewLogin, null, 'an explicit null must clear it');
  db.close();
});

test('an outstanding change request from anyone else holds the merge', async () => {
  // Naming an approver moves who may say yes. It does not take away everyone
  // else's no - and `approvalAtHead` only ever looked at the nominated login,
  // so a maintainer blocking the PR was invisible to it.
  const { db, automations, client } = fixture([
    review(),
    { user: { login: 'maintainer' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-08-26T13:00:00Z', commit_id: 'HEAD_SHA' },
  ]);
  const result = await verdict(automations, client);
  assert.equal(result.approved, true, 'the nominated reviewer did approve');
  assert.equal(result.blockedBy, 'maintainer', 'someone else blocking must be reported');
  db.close();
});

test('a reviewer who requested changes and then approved no longer blocks', async () => {
  const { db, automations, client } = fixture([
    { user: { login: 'maintainer' }, state: 'CHANGES_REQUESTED', submitted_at: '2026-08-26T12:00:00Z', commit_id: 'HEAD_SHA' },
    { user: { login: 'maintainer' }, state: 'APPROVED', submitted_at: '2026-08-26T13:00:00Z', commit_id: 'HEAD_SHA' },
    review(),
  ]);
  const result = await verdict(automations, client);
  assert.equal(result.blockedBy, null, 'only the LATEST decision per reviewer counts');
  db.close();
});

test('a truncated review list holds the merge', async () => {
  // GitHub returns reviews oldest-first, so the unread pages are the NEWEST.
  // Treating a prefix as complete reaches the opposite conclusion from truth.
  const { db, automations, client } = fixture('truncated');
  assert.equal(await ask(automations, client), false);
  db.close();
});
