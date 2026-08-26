import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import { Automations } from '../dist/api/automations.js';
import { AutomationsStore } from '../dist/api/automations-store.js';
import migrations from '../dist/api/migrations.js';

/**
 * These drive `runDelivery`, not the gate in isolation.
 *
 * The gate's value is entirely in where it sits and how it exits: ahead of the
 * pipeline auto-run that starts an agent, and throwing rather than returning
 * when it cannot reach a decision. Calling the private method directly asserts
 * neither - it passes just as well with the gate in the wrong place and with a
 * refusal that silently completes the delivery.
 *
 * Only the seams the path actually reaches are real. Everything else is a
 * positional placeholder, so a constructor change fails here rather than
 * quietly stubbing the subject out.
 */
function fixture({ issue, permission, throws = false, admitLabel = 'agent:ready' } = {}) {
  const db = new Database(':memory:');
  for (const migration of migrations) migration.up(db);
  const empty = {};
  const events = [];
  const store = new AutomationsStore({
    db,
    repos: {
      get: () => ({ full_name: 'acme/app', auto_triage: 1, automation_owner_id: 'alice' }),
      inWorkspace: () => true,
      getWebhookRegistration: () => ({ ownerId: 'alice', remoteId: 'wh-1', remoteError: null }),
    },
    issues: empty,
    prs: empty,
    runs: empty,
    workspaces: empty,
    reports: empty,
    settings: empty,
    notify: { emit() {} },
  });
  const client = {
    issue: async () => {
      if (throws) throw new Error('502 bad gateway');
      return issue;
    },
    collaboratorPermission: async () => {
      if (throws) throw new Error('502 bad gateway');
      return permission;
    },
  };
  const triage = {
    triageIssueOnce: async () => {
      events.push('MODEL CALL: triage');
      return { status: 'dismissed', verdict: null };
    },
  };
  const pipelines = {
    autoRunForIssue: () => {
      events.push('AGENT PIPELINE STARTED');
      return { failures: [] };
    },
  };
  const automations = new Automations(
    store,
    {}, triage, {}, {}, pipelines, { applyIssue() {} }, {}, {}, {}, {},
    () => client,
    () => ({ ensureAutomationWorkers() {}, tightenIssueAutomation: () => 0 }),
    () => true,
    () => {},
    () => {},
  );
  if (admitLabel !== undefined) {
    automations.setContributorFlow({
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
      admitLabel,
    });
  }
  return { db, store, automations, events };
}

const openIssue = (labels) => ({
  number: 7,
  state: 'open',
  labels,
  title: 't',
  body: '',
  user: { login: 'dana' },
  assignees: [],
  comments: 0,
  html_url: '',
  created_at: '',
  updated_at: '',
  closed_at: null,
});

/** Enqueue a real webhook-shaped delivery and run it the way the pump does. */
async function deliver(store, automations, { action, sender, label }) {
  store.enqueueDelivery({
    id: `d-${action}-${label ?? 'none'}-${sender ?? 'none'}`,
    repo: 'acme/app',
    event: 'issues',
    action,
    payload: JSON.stringify({
      action,
      webhookOwnerId: 'alice',
      automationOwnerId: 'alice',
      senderLogin: sender,
      label,
      issue: openIssue([{ name: 'agent:ready' }]),
    }),
    orderingKey: 'acme/app:issue:7',
  });
  const [job] = store.claimDueDeliveries(1, Date.now(), []);
  assert.ok(job, 'the delivery was not claimable');
  await automations.runDelivery(job);
  return store.db ?? null;
}

const rowFor = (db, id) =>
  db.prepare(`SELECT status, attempts, next_attempt_at FROM automation_deliveries WHERE id = ?`).get(id);

test('an authorised collaborator applying the admit label admits the issue', async () => {
  const { db, store, automations, events } = fixture({
    issue: openIssue([{ name: 'agent:ready' }]),
    permission: 'write',
  });
  await deliver(store, automations, { action: 'labeled', sender: 'carol', label: 'agent:ready' });
  assert.deepEqual(events, ['AGENT PIPELINE STARTED', 'MODEL CALL: triage']);
  db.close();
});

test('an unrelated label from a maintainer does not admit a still-labelled issue', async () => {
  // The issue still carries `agent:ready` from someone who could not admit it.
  // A maintainer later adds `duplicate`. Matching on "some label was applied by
  // someone with write" would admit here, on a decision she never took.
  const { db, store, automations, events } = fixture({
    issue: openIssue([{ name: 'agent:ready' }]),
    permission: 'admin',
  });
  await deliver(store, automations, { action: 'labeled', sender: 'carol', label: 'duplicate' });
  assert.deepEqual(events, [], 'an unrelated label started work');
  db.close();
});

test('the agent pipeline does not start ahead of a refusal', async () => {
  // The pipeline's issue steps include `agent`, so a gate below it does not
  // gate: the work it refuses has already started.
  const { db, store, automations, events } = fixture({
    issue: openIssue([{ name: 'agent:ready' }]),
    permission: 'read',
  });
  await deliver(store, automations, { action: 'labeled', sender: 'mallory', label: 'agent:ready' });
  assert.deepEqual(events, [], 'a refused issue still started an agent pipeline');
  db.close();
});

test('a policy refusal finishes the delivery', async () => {
  const { db, store, automations } = fixture({
    issue: openIssue([{ name: 'agent:ready' }]),
    permission: 'triage',
  });
  await deliver(store, automations, { action: 'labeled', sender: 'mallory', label: 'agent:ready' });
  const row = rowFor(db, 'd-labeled-agent:ready-mallory');
  assert.equal(row.status, 'completed', 'a decided refusal should not be retried forever');
  db.close();
});

test('an unreachable GitHub retries instead of completing', async () => {
  // The failure this guards: a 30-second API blip marks a SANCTIONED admission
  // completed, the health page shows green, the label sits on the issue forever
  // and `retryDelivery` cannot reach a completed row.
  const { db, store, automations } = fixture({
    issue: openIssue([{ name: 'agent:ready' }]),
    permission: 'admin',
    throws: true,
  });
  await deliver(store, automations, { action: 'labeled', sender: 'carol', label: 'agent:ready' });
  const row = rowFor(db, 'd-labeled-agent:ready-carol');
  assert.notEqual(row.status, 'completed', 'a transient API failure silently dropped the admission');
  assert.ok(row.attempts >= 1);
  db.close();
});

test('with no admission label the flow still reacts to opened and ignores labeled', async () => {
  const { db, store, automations, events } = fixture({
    issue: openIssue([]),
    permission: 'none',
    admitLabel: null,
  });
  await deliver(store, automations, { action: 'labeled', sender: 'carol', label: 'anything' });
  assert.deepEqual(events, [], 'labeled triggered a flow that named no admission label');

  await deliver(store, automations, { action: 'opened', sender: 'carol', label: null });
  assert.deepEqual(events, ['AGENT PIPELINE STARTED', 'MODEL CALL: triage'], 'opened stopped working');
  db.close();
});

test('a delivery with no known actor is refused', async () => {
  const { db, store, automations, events } = fixture({
    issue: openIssue([{ name: 'agent:ready' }]),
    permission: 'admin',
  });
  await deliver(store, automations, { action: 'labeled', sender: null, label: 'agent:ready' });
  assert.deepEqual(events, [], 'an event with no actor admitted work');
  db.close();
});

test('an omitted admitLabel preserves the stored one', () => {
  // There is no UI field for this yet, so a save from any surface that has not
  // been taught about it must not clear the gate.
  const { db, store, automations } = fixture({ admitLabel: 'agent:ready' });
  automations.setContributorFlow({
    workspaceId: 'ws-1',
    repo: 'acme/app',
    mode: 'governed',
    actionableIssueKinds: ['bug'],
    queueIssues: true,
    autoApplyTriage: false,
    mergeMethod: 'squash',
    maxAttempts: 5,
    ownerId: 'alice',
    updatedAt: 11,
  });
  const saved = store.contributorFlow('acme/app');
  assert.equal(saved.admitLabel, 'agent:ready', 'a save without the field switched the gate off');
  assert.equal(saved.maxAttempts, 5, 'the save did not take');

  automations.setContributorFlow({ ...saved, admitLabel: null, updatedAt: 12 });
  assert.equal(store.contributorFlow('acme/app').admitLabel, null, 'an explicit null must clear it');
  db.close();
});

test('an empty stored label reads as absent, and the migration is idempotent', () => {
  const { db, store } = fixture({ admitLabel: 'agent:ready' });
  // Read as a label, an empty string makes the gate unsatisfiable with no
  // refusal to read - silence, which is the worse of the two failures.
  db.prepare(`UPDATE contributor_flows SET admit_label = '' WHERE repo = ?`).run('acme/app');
  assert.equal(store.contributorFlow('acme/app').admitLabel, null);

  const sixth = migrations.find((m) => m.version === 6);
  sixth.up(db);
  assert.equal(store.contributorFlow('acme/app').admitLabel, null, 're-running the migration lost data');
  db.close();
});
