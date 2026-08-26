import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import { Automations } from '../dist/api/automations.js';
import { AutomationsStore } from '../dist/api/automations-store.js';
import migrations from '../dist/api/migrations.js';

/**
 * Only the seams `admissionRefusal` actually reaches are real: the store, and
 * the GitHub client factory. Everything else is a positional placeholder, so a
 * constructor change surfaces as a failure here rather than as a test that
 * quietly stopped exercising the gate.
 */
function fixture({ issue, permission, throws = false } = {}) {
  const db = new Database(':memory:');
  for (const migration of migrations) migration.up(db);
  const empty = {};
  const store = new AutomationsStore({
    db,
    repos: empty,
    issues: empty,
    prs: empty,
    runs: empty,
    workspaces: empty,
    reports: empty,
    settings: empty,
    notify: { emit() {} },
  });
  const calls = [];
  const client = {
    issue: async (repo, number) => {
      calls.push(`issue:${repo}#${number}`);
      if (throws) throw new Error('502 bad gateway');
      return issue;
    },
    collaboratorPermission: async (repo, username) => {
      calls.push(`permission:${username}`);
      if (throws) throw new Error('502 bad gateway');
      return permission;
    },
  };
  const automations = new Automations(
    store,
    {}, {}, {}, {}, {}, {}, {}, {}, {}, {},
    () => client,
    () => undefined,
    () => true,
    () => {},
    () => {},
  );
  return { db, store, automations, calls };
}

const FLOW = Object.freeze({
  workspaceId: 'ws-1',
  repo: 'acme/app',
  mode: 'governed',
  actionableIssueKinds: ['bug'],
  queueIssues: true,
  autoApplyTriage: false,
  mergeMethod: 'squash',
  maxAttempts: 4,
  ownerId: 'alice',
  updatedAt: 10,
  admitLabel: 'agent:ready',
});

const job = (senderLogin) => ({
  repo: 'acme/app',
  payload: JSON.stringify({
    action: 'labeled',
    webhookOwnerId: 'alice',
    automationOwnerId: 'alice',
    senderLogin,
  }),
});

const openIssue = (labels) => ({ number: 7, state: 'open', labels });

test('an authorised collaborator applying the label admits the issue', async () => {
  const { db, automations, calls } = fixture({
    issue: openIssue([{ name: 'agent:ready' }]),
    permission: 'write',
  });
  const refusal = await automations.admissionRefusal(job('carol'), FLOW, { number: 7 }, 'agent:ready');
  assert.equal(refusal, null);
  // Both facts came from GitHub, not from the delivery.
  assert.deepEqual(calls, ['issue:acme/app#7', 'permission:carol']);
  db.close();
});

test('a label removed after the event is refused', async () => {
  // The delivery says `labeled`; live state says otherwise. The queue is
  // durable, so this is a race that really happens rather than a hypothetical.
  const { db, automations } = fixture({ issue: openIssue([]), permission: 'write' });
  const refusal = await automations.admissionRefusal(job('carol'), FLOW, { number: 7 }, 'agent:ready');
  assert.match(refusal, /agent:ready is not on the issue/);
  db.close();
});

test('a closed issue is refused even while it carries the label', async () => {
  const { db, automations } = fixture({
    issue: { number: 7, state: 'closed', labels: [{ name: 'agent:ready' }] },
    permission: 'write',
  });
  const refusal = await automations.admissionRefusal(job('carol'), FLOW, { number: 7 }, 'agent:ready');
  assert.match(refusal, /closed/);
  db.close();
});

test('read and triage may apply a label but may not admit work', async () => {
  // The bar is the bar for changing the repository, not for labelling it.
  for (const permission of ['read', 'triage', 'none']) {
    const { db, automations } = fixture({
      issue: openIssue([{ name: 'agent:ready' }]),
      permission,
    });
    const refusal = await automations.admissionRefusal(job('mallory'), FLOW, { number: 7 }, 'agent:ready');
    assert.match(refusal, /mallory may not admit work here/, `${permission} was allowed to admit`);
    db.close();
  }
});

test('write, maintain and admin may admit', async () => {
  for (const permission of ['write', 'maintain', 'admin']) {
    const { db, automations } = fixture({
      issue: openIssue([{ name: 'agent:ready' }]),
      permission,
    });
    const refusal = await automations.admissionRefusal(job('carol'), FLOW, { number: 7 }, 'agent:ready');
    assert.equal(refusal, null, `${permission} was refused`);
    db.close();
  }
});

test('a delivery with no known actor is refused before GitHub is asked', async () => {
  // A job persisted before the sender was captured reads as "no known actor".
  // Refusing costs a re-label; guessing an actor would admit on nobody's say-so.
  const { db, automations, calls } = fixture({
    issue: openIssue([{ name: 'agent:ready' }]),
    permission: 'admin',
  });
  const refusal = await automations.admissionRefusal(job(null), FLOW, { number: 7 }, 'agent:ready');
  assert.match(refusal, /acting GitHub account is unknown/);
  assert.deepEqual(calls, [], 'GitHub was asked about an event with no actor');
  db.close();
});

test('an unreachable GitHub fails closed', async () => {
  const { db, automations } = fixture({
    issue: openIssue([{ name: 'agent:ready' }]),
    permission: 'admin',
    throws: true,
  });
  const refusal = await automations.admissionRefusal(job('carol'), FLOW, { number: 7 }, 'agent:ready');
  assert.match(refusal, /could not confirm admission/);
  db.close();
});

test('a bare string label is matched as well as an object', async () => {
  // GitHub returns either shape depending on the endpoint; matching only the
  // object form would silently never admit.
  const { db, automations } = fixture({ issue: openIssue(['agent:ready']), permission: 'write' });
  assert.equal(await automations.admissionRefusal(job('carol'), FLOW, { number: 7 }, 'agent:ready'), null);
  db.close();
});

test('the admission label round-trips, and an empty one reads as absent', () => {
  const { db, store } = fixture({});
  store.setContributorFlow(FLOW);
  assert.equal(store.contributorFlow('acme/app').admitLabel, 'agent:ready');

  // An empty string is not a label. Read as one it would make the gate
  // unsatisfiable rather than absent - the flow would go silent with no refusal
  // to read, which is the worse of the two failures.
  db.prepare(`UPDATE contributor_flows SET admit_label = '' WHERE repo = ?`).run('acme/app');
  assert.equal(store.contributorFlow('acme/app').admitLabel, null);

  db.prepare(`UPDATE contributor_flows SET admit_label = NULL WHERE repo = ?`).run('acme/app');
  assert.equal(store.contributorFlow('acme/app').admitLabel, null);
  db.close();
});
