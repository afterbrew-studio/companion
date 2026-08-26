import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import { Automations, boundedRoundRobin } from '../dist/api/automations.js';
import {
  AutomationsStore,
  DELIVERY_ACTIVE_REPO_LIMIT,
} from '../dist/api/automations-store.js';
import migrations from '../dist/api/migrations.js';

function fixture() {
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
  return { db, store };
}

const delivery = Object.freeze({
  id: 'delivery-1',
  repo: 'acme/app',
  event: 'issues',
  action: 'opened',
  payload: '{"issue":{"number":42}}',
  orderingKey: 'acme/app:issue:42',
});

test('a delivery is durable before acknowledgement and duplicate-safe', () => {
  const { db, store } = fixture();

  assert.equal(store.enqueueDelivery(delivery, 1_000), 'accepted');
  assert.equal(store.enqueueDelivery({ ...delivery, payload: 'different' }, 2_000), 'duplicate');

  const [job] = store.claimDueDeliveries(4, 1_000);
  assert.equal(job.id, delivery.id);
  assert.equal(job.payload, delivery.payload);
  assert.equal(job.status, 'processing');
  assert.equal(job.attempts, 1);
  assert.equal(store.claimDueDeliveries(4, 1_000).length, 0);

  const publicRecord = store.deliveryHealth(['acme/app']).recent[0];
  assert.equal(Object.hasOwn(publicRecord, 'payload'), false, 'webhook bodies must never cross to the SPA');

  db.close();
});

test('delivery health stays scoped beyond one SQLite parameter batch', () => {
  const { db, store } = fixture();
  store.enqueueDelivery(delivery, 1_000);
  const repos = Array.from({ length: 1_205 }, (_, index) => `org/repo-${index}`);
  repos.splice(733, 0, 'acme/app');
  repos.push('acme/app');

  const health = store.deliveryHealth(repos);
  assert.equal(health.queued, 1);
  assert.deepEqual(health.recent.map((row) => row.id), [delivery.id]);
  db.close();
});

test('active delivery admission is bounded per repository without rejecting durable duplicates', () => {
  const { db, store } = fixture();
  for (let index = 0; index < DELIVERY_ACTIVE_REPO_LIMIT; index += 1) {
    assert.equal(store.enqueueDelivery({ ...delivery, id: `delivery-${index}` }, 1_000 + index), 'accepted');
  }
  assert.equal(store.enqueueDelivery({ ...delivery, id: 'one-too-many' }, 2_000), 'saturated');
  assert.equal(
    store.enqueueDelivery({ ...delivery, id: 'delivery-0', payload: 'retry body is irrelevant' }, 2_001),
    'duplicate',
  );
  db.close();
});

test('operator pause refuses new work while durable duplicates and admitted work drain safely', () => {
  const { db, store } = fixture();
  assert.equal(store.enqueueDelivery(delivery, 1_000), 'accepted');
  const control = store.setAdmissionControl('acme/app', true, 'incident-commander', 'GitHub outage', 2_000);
  assert.deepEqual(control, {
    repo: 'acme/app',
    paused: true,
    reason: 'GitHub outage',
    pausedBy: 'incident-commander',
    pausedAt: 2_000,
  });

  assert.equal(store.enqueueDelivery({ ...delivery, payload: 'duplicate retry' }, 2_001), 'duplicate');
  assert.equal(store.enqueueDelivery({ ...delivery, id: 'new-during-pause' }, 2_002), 'paused');
  const [admitted] = store.claimDueDeliveries(1, 2_003);
  assert.equal(admitted.id, delivery.id, 'already-durable work is allowed to drain');
  store.completeDelivery(admitted.id, 'Drained', 2_004);

  store.setAdmissionControl('acme/app', false, 'incident-commander', '', 3_000);
  assert.equal(store.enqueueDelivery({ ...delivery, id: 'new-after-resume' }, 3_001), 'accepted');
  assert.equal(store.admissionControl('acme/app').paused, false);
  db.close();
});

test('a valid signed webhook receives retryable 503 while admission is paused', () => {
  const { db, store } = fixture();
  const secret = 'pause-secret';
  store.repos.getWebhookRegistration = () => ({ secret, ownerId: 'alice', accountId: 'gh-1' });
  store.repos.get = () => ({ automation_owner_id: 'alice' });
  store.setAdmissionControl('acme/app', true, 'alice', 'runner incident', 1_000);
  const automations = new Automations(
    store,
    {}, {}, {}, {}, {}, {}, {}, {}, {}, {},
    () => null,
    () => undefined,
    () => true,
    () => undefined,
    () => undefined,
  );
  const raw = Buffer.from(JSON.stringify({
    action: 'opened',
    repository: { full_name: 'acme/app' },
    issue: { number: 7, title: 'Queued later', body: '', state: 'open', labels: [], user: { login: 'author' } },
  }));
  const response = automations.handleDelivery('acme/app', {
    'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
    'x-github-event': 'issues',
    'x-github-delivery': 'paused-delivery',
  }, raw);
  assert.equal(response.status, 503);
  assert.match(response.body, /admission paused/);
  assert.equal(store.deliveryHealth(['acme/app']).queued, 0);
  db.close();
});

test('a saturated signed webhook is rejected honestly and alerts only once per hour', () => {
  const { db, store } = fixture();
  const secret = 'capacity-secret';
  store.repos.getWebhookRegistration = () => ({ secret, ownerId: 'alice', accountId: 'gh-1' });
  store.repos.get = () => ({ automation_owner_id: 'alice', workspace_id: 'ws-1' });
  for (let index = 0; index < DELIVERY_ACTIVE_REPO_LIMIT; index += 1) {
    store.enqueueDelivery({ ...delivery, id: `capacity-${index}` }, 1_000 + index);
  }
  const audits = [];
  const automations = new Automations(
    store,
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    () => null,
    () => undefined,
    () => true,
    (event) => audits.push(event),
    () => undefined,
  );
  const raw = Buffer.from(JSON.stringify({
    action: 'opened',
    repository: { full_name: 'acme/app' },
    issue: { number: 99, title: 'Overflow', body: '', state: 'open', labels: [], user: { login: 'contributor' } },
  }));
  const headers = {
    'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`,
    'x-github-event': 'issues',
    'x-github-delivery': 'capacity-overflow',
  };

  assert.equal(automations.handleDelivery('acme/app', headers, raw).status, 503);
  assert.equal(automations.handleDelivery('acme/app', headers, raw).status, 503);
  assert.equal(audits.filter((event) => event.action === 'webhook.delivery.saturated').length, 1);
  db.close();
});

test('restart recovery releases processing leases without losing their payload', () => {
  const { db, store } = fixture();
  store.enqueueDelivery(delivery, 1_000);
  store.claimDueDeliveries(1, 1_000);

  assert.equal(store.recoverDeliveries(2_000), 1);
  const health = store.deliveryHealth(['acme/app']);
  assert.equal(health.retrying, 1);
  assert.equal(health.recent[0].stage, 'Recovered after restart');

  const [recovered] = store.claimDueDeliveries(1, 2_000);
  assert.equal(recovered.payload, delivery.payload);
  assert.equal(recovered.attempts, 2);
  store.completeDelivery(recovered.id, 'Triaged and queued', 3_000);
  assert.equal(store.deliveryHealth(['acme/app']).recent[0].status, 'completed');

  db.close();
});

test('deliveries stay ordered per subject while unrelated work runs concurrently', () => {
  const { db, store } = fixture();
  // UUID lexical order is unrelated to GitHub arrival order, and multiple
  // hooks regularly land in one millisecond. The insertion sequence must win.
  store.enqueueDelivery({ ...delivery, id: 'same-z' }, 1_000);
  store.enqueueDelivery({ ...delivery, id: 'same-a', action: 'edited' }, 1_000);
  store.enqueueDelivery({
    ...delivery,
    id: 'other-pr',
    event: 'pull_request',
    repo: 'acme/app',
    orderingKey: 'acme/app:pr:7',
  }, 1_000);

  const first = store.claimDueDeliveries(4, 2_000);
  assert.deepEqual(first.map((job) => job.id), ['same-z', 'other-pr']);
  store.completeDelivery('same-z', 'Completed', 2_001);
  assert.deepEqual(store.claimDueDeliveries(4, 2_002).map((job) => job.id), ['same-a']);

  db.close();
});

test('a delayed retry holds its subject without blocking another subject', () => {
  const { db, store } = fixture();
  store.enqueueDelivery({ ...delivery, id: 'head' }, 1_000);
  let [head] = store.claimDueDeliveries(1, 1_000);
  store.failDelivery(head.id, 'temporary', 8, 1_000);
  store.enqueueDelivery({ ...delivery, id: 'later' }, 2_000);
  store.enqueueDelivery({
    ...delivery,
    id: 'parallel',
    repo: 'acme/other',
    orderingKey: 'acme/other:issue:42',
  }, 2_001);

  assert.deepEqual(store.claimDueDeliveries(4, 2_100).map((job) => job.id), ['parallel']);
  [head] = store.claimDueDeliveries(4, 16_000);
  assert.equal(head.id, 'head');

  db.close();
});

test('failures back off, become terminal at the ceiling, and retry only in scope', () => {
  const { db, store } = fixture();
  store.enqueueDelivery(delivery, 1_000);

  let [job] = store.claimDueDeliveries(1, 1_000);
  assert.equal(store.failDelivery(job.id, 'temporary', 2, 1_000), 'retrying');
  assert.equal(store.claimDueDeliveries(1, 15_999).length, 0);

  [job] = store.claimDueDeliveries(1, 16_000);
  assert.equal(store.failDelivery(job.id, 'still broken', 2, 16_000), 'failed');
  assert.equal(store.deliveryHealth(['acme/app']).failed, 1);
  assert.equal(store.retryDelivery(job.id, ['other/repo'], 20_000), 'not-found');
  store.setAdmissionControl('acme/app', true, 'incident-commander', 'runner incident', 19_000);
  assert.equal(store.retryDelivery(job.id, ['acme/app'], 20_000), 'paused');
  assert.equal(store.deliveryHealth(['acme/app']).failed, 1, 'paused retry remains safely terminal');
  store.setAdmissionControl('acme/app', false, 'incident-commander', '', 20_000);
  assert.equal(store.retryDelivery(job.id, ['acme/app'], 20_000), 'retried');

  const [manual] = store.claimDueDeliveries(1, 20_000);
  assert.equal(manual.attempts, 1, 'manual retry receives a fresh bounded attempt budget');
  assert.equal(manual.lastError, null);

  db.close();
});

test('manual retry cannot bypass the active delivery ceiling', () => {
  const { db, store } = fixture();
  store.enqueueDelivery({ ...delivery, id: 'failed-delivery' }, 1_000);
  const [failed] = store.claimDueDeliveries(1, 1_000);
  store.failDelivery(failed.id, 'terminal', 1, 1_000);

  for (let index = 0; index < DELIVERY_ACTIVE_REPO_LIMIT; index += 1) {
    assert.equal(
      store.enqueueDelivery({ ...delivery, id: `active-${index}` }, 2_000 + index),
      'accepted',
    );
  }
  assert.equal(store.retryDelivery(failed.id, ['acme/app'], 3_000), 'saturated');
  assert.equal(store.deliveryHealth(['acme/app']).retrying, 0);
  assert.equal(store.deliveryHealth(['acme/app']).failed, 1);
  db.close();
});

test('bounded scheduler windows rotate without starving later candidates', () => {
  const first = boundedRoundRobin(['a', 'b', 'c', 'd'], 0, 2);
  const second = boundedRoundRobin(['a', 'b', 'c', 'd'], first.nextCursor, 2);
  assert.deepEqual(first, { selected: ['a', 'b'], nextCursor: 2 });
  assert.deepEqual(second, { selected: ['c', 'd'], nextCursor: 0 });
  assert.deepEqual(boundedRoundRobin(['a'], Number.NaN, 20), { selected: ['a'], nextCursor: 0 });
});

test('contributor policy round-trips and malformed issue kinds fail closed', () => {
  const { db, store } = fixture();
  const policy = {
    workspaceId: 'ws-1',
    repo: 'acme/app',
    mode: 'governed',
    actionableIssueKinds: ['bug', 'docs'],
    queueIssues: true,
    autoApplyTriage: false,
    mergeMethod: 'squash',
    maxAttempts: 4,
    ownerId: 'alice',
    updatedAt: 10,
    admitLabel: null,
    externalReviewLogin: null,
  };

  store.setContributorFlow(policy);
  assert.deepEqual(store.contributorFlow('acme/app'), policy);
  assert.deepEqual(store.listContributorFlows('ws-1'), [policy]);

  db.prepare(`UPDATE contributor_flows SET actionable_issue_kinds = 'not-json' WHERE repo = ?`).run('acme/app');
  assert.deepEqual(store.contributorFlow('acme/app').actionableIssueKinds, []);

  store.removeContributorFlow('acme/app');
  assert.equal(store.contributorFlow('acme/app'), null);
  db.close();
});

test('a pre-durable processing row is surfaced as failed during upgrade', () => {
  const db = new Database(':memory:');
  migrations[0].up(db);
  db.prepare(
    `INSERT INTO automation_deliveries (id, repo, event, status, received_at, completed_at)
     VALUES (?, ?, ?, 'processing', ?, NULL)`,
  ).run('legacy-1', 'acme/app', 'issues', 1_000);

  migrations[1].up(db);
  const row = db.prepare(`SELECT status, stage, last_error FROM automation_deliveries WHERE id = ?`).get('legacy-1');
  assert.equal(row.status, 'failed');
  assert.match(row.stage, /cannot be replayed/);
  assert.match(row.last_error, /before durable webhook payloads/);

  db.close();
});

test('the durable inbox stores a bounded projection instead of a multi-megabyte webhook body', () => {
  const { db, store } = fixture();
  const secret = 'test-webhook-secret';
  store.repos.getWebhookRegistration = () => ({ secret, ownerId: 'alice', accountId: 'gh-1' });
  store.repos.get = () => ({ automation_owner_id: 'alice' });
  const automations = new Automations(
    store,
    {},
    {},
    {},
    {},
    {},
    { applyIssue() {} },
    {},
    {},
    {},
    {},
    () => null,
    () => undefined,
    () => true,
    () => undefined,
    () => undefined,
  );
  const raw = Buffer.from(JSON.stringify({
    action: 'opened',
    repository: { full_name: 'acme/app' },
    issue: {
      number: 42,
      title: 'x'.repeat(10_000),
      body: 'b'.repeat(500_000),
      state: 'open',
      labels: Array.from({ length: 500 }, (_, index) => ({ name: `label-${index}-${'x'.repeat(500)}` })),
      user: { login: 'contributor' },
      assignees: [],
      comments: 0,
      html_url: 'https://github.com/acme/app/issues/42',
      created_at: '2026-08-02T00:00:00Z',
      updated_at: '2026-08-02T00:00:00Z',
      closed_at: null,
    },
    installation: { token: 'must-never-be-stored' },
  }));
  const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

  const response = automations.handleDelivery('acme/app', {
    'x-hub-signature-256': signature,
    'x-github-event': 'issues',
    'x-github-delivery': 'bounded-1',
  }, raw);
  assert.equal(response.status, 202);
  const row = db.prepare(`SELECT payload FROM automation_deliveries WHERE id = ?`).get('bounded-1');
  const projected = JSON.parse(row.payload);
  assert.equal(projected.issue.title.length, 500);
  assert.equal(projected.issue.body.length, 64_000);
  assert.equal(projected.issue.labels.length, 100);
  assert.equal(row.payload.includes('must-never-be-stored'), false);
  assert.ok(row.payload.length < 100_000);

  db.close();
});

test('webhook break-glass disables locally without borrowing the former owner account', async () => {
  const { db, store } = fixture();
  let cleared = 0;
  let deleted = 0;
  store.repos.getWebhookRegistration = () => ({
    secret: 'server-only',
    ownerId: 'alice',
    accountId: 'alice-account',
    remoteId: 73,
    remoteError: null,
  });
  store.repos.clearWebhookRegistration = () => {
    cleared += 1;
  };
  const automations = new Automations(
    store,
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    { deliveryUrl: () => 'https://companion.example/webhooks/github/acme/app' },
    {},
    {},
    () => null,
    () => undefined,
    () => true,
    () => undefined,
    () => undefined,
  );
  const client = {
    deleteRepoWebhook: async () => {
      deleted += 1;
    },
  };

  await assert.rejects(() => automations.disableWebhook('acme/app', 'bob', client), /only the webhook owner/);
  assert.equal(cleared, 0);
  assert.equal(deleted, 0);

  const warning = await automations.disableWebhook('acme/app', 'bob', null, true);
  assert.equal(cleared, 1, 'local HMAC receiver is the immediate safety boundary');
  assert.equal(deleted, 0, 'break-glass must not use a client belonging to another profile');
  assert.match(warning, /Delete GitHub webhook #73 manually/);

  const visible = automations.webhookInfo('acme/app', 'bob', null);
  assert.equal(visible.ownerId, 'alice');
  assert.equal(visible.accountId, null, 'another profile cannot address the owner account id');
  assert.equal(visible.remoteId, null, 'remote metadata remains private to its owner');
  db.close();
});

test('a private workspace briefing pauses when its owner loses membership', async () => {
  const values = new Map([
    ['briefing:ws-private', 'daily'],
    ['briefingOwner:ws-private', 'alice'],
  ]);
  const notifications = [];
  const audits = [];
  const workspace = { id: 'ws-private', name: 'Private', visibility: 'private' };
  const store = {
    listAllContributorFlows: () => [],
    isAdmissionPaused: () => false,
    repos: {
      list: () => [],
      listByWorkspace: () => [],
    },
    workspaces: {
      list: () => [workspace],
      get: () => workspace,
      isMember: () => false,
    },
    settings: {
      get: (key) => values.get(key) ?? null,
      set: (key, value) => values.set(key, value),
    },
    notifications: { insert: (notification) => notifications.push(notification) },
  };
  const automations = new Automations(
    store,
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    () => null,
    () => undefined,
    () => true,
    (event) => audits.push(event),
    () => undefined,
  );

  await automations.tick(2 * 24 * 60 * 60_000);
  await automations.tick(2 * 24 * 60 * 60_000 + 1);

  assert.equal(notifications.length, 1, 'a minute ticker must not flood the workspace inbox');
  assert.equal(notifications[0].workspaceId, 'ws-private');
  assert.equal(notifications[0].repo, null);
  assert.match(notifications[0].body, /no longer a member/);
  assert.equal(audits[0].action, 'automation.workspace-briefing.paused');
  assert.equal(audits[0].actor, 'alice');
});
