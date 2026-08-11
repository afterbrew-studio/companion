import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import { JiraCloudClient, normalizeIssueKey } from '../dist/api/jira-client.js';
import { JiraStore } from '../dist/api/jira-store.js';
import { jiraAutomationProvider, sendAutomation } from '../dist/api/providers.js';
import migrations from '../dist/api/migrations.js';

test('Jira issue keys are normalized without accepting arbitrary path input', () => {
  assert.equal(normalizeIssueKey(' platform-142 '), 'PLATFORM-142');
  for (const value of ['../myself', 'ABC-0', 'A B-2', 'https://jira/ABC-1']) {
    assert.throws(() => normalizeIssueKey(value), /must look like PROJECT-123/);
  }
});

test('Jira credentials can only be sent to an HTTPS origin', () => {
  const connection = (baseUrl) => ({
    record: { config: { baseUrl, email: 'bot@example.test' } },
    secret: (key) => key === 'apiToken' ? 'secret' : null,
  });
  assert.throws(() => new JiraCloudClient(connection('http://jira.internal')), /must be an HTTPS origin/);
  assert.throws(() => new JiraCloudClient(connection('https://user:pass@example.test')), /without embedded credentials/);
  assert.throws(() => new JiraCloudClient(connection('https://acme.atlassian.net/path')), /must be the site origin/);
  assert.throws(() => new JiraCloudClient(connection('https://jira.internal.example/')), /atlassian\.net hostname/);
  assert.doesNotThrow(() => new JiraCloudClient(connection('https://acme.atlassian.net/')));
});

test('linked ticket snapshots are scoped by workspace and GitHub subject', () => {
  const db = new Database(':memory:');
  for (const migration of migrations) migration.up(db);
  const store = new JiraStore(db);
  const link = {
    id: 'jl-1',
    connectionId: 'jira-team',
    workspaceId: 'ws-one',
    subject: { kind: 'pull-request', repo: 'acme/app', number: 7 },
    issue: {
      key: 'PLATFORM-142',
      summary: 'Ship integration framework',
      status: 'In Progress',
      statusCategory: 'In Progress',
      issueType: 'Story',
      url: 'https://acme.atlassian.net/browse/PLATFORM-142',
    },
    createdBy: 'ana',
    createdAt: 1,
    updatedAt: 1,
  };
  assert.equal(store.insert(link), true);
  assert.equal(store.insert({ ...link, id: 'jl-duplicate' }), false);
  assert.equal(
    store.find(link.workspaceId, link.subject, link.connectionId, link.issue.key)?.id,
    'jl-1',
  );

  assert.equal(store.list('ws-one', { kind: 'pull-request', repo: 'acme/app', number: 7 }).length, 1);
  assert.equal(store.list('ws-two', { kind: 'pull-request', repo: 'acme/app', number: 7 }).length, 0);
  assert.equal(store.list('ws-one', { kind: 'issue', repo: 'acme/app', number: 7 }).length, 0);
  assert.equal(store.list('ws-one', { kind: 'pull-request', repo: 'other/app', number: 7 }).length, 0);
  assert.equal(store.insert({ ...link, id: 'jl-other-workspace', workspaceId: 'ws-two' }), true);
  db.close();
});

// ---------- automation delivery retries (aligned with modules/notify delivery) ----------

const automationConnection = {
  record: { config: {} },
  secret: (key) => (key === 'url' ? 'https://automation.atlassian.com/pro/hooks/abc' : null),
};
const AUTOMATION_NOTIFICATION = {
  id: 'n1',
  kind: 'finished',
  title: 'Run finished',
  body: 'done',
  workspaceId: null,
  repo: null,
  href: null,
  url: null,
  createdAt: 1,
};

/** Emulates withPublicHttpResponse: hand the stubbed response to the consumer. */
const transportWith = (respond) => async (_target, _init, consume) => consume(await respond());

test('Jira Automation retries a 503 once and can succeed on the second attempt', async () => {
  let calls = 0;
  const outcome = await sendAutomation(
    automationConnection,
    AUTOMATION_NOTIFICATION,
    transportWith(async () => {
      calls++;
      return calls === 1 ? { ok: false, status: 503, body: null } : { ok: true, status: 200, body: null };
    }),
  );
  assert.equal(calls, 2);
  assert.deepEqual(outcome, { ok: true, httpStatus: 200, error: null, attempts: 2 });
});

test('Jira Automation treats rate limiting as transient', async () => {
  let calls = 0;
  const outcome = await sendAutomation(
    automationConnection,
    AUTOMATION_NOTIFICATION,
    transportWith(async () => {
      calls++;
      return { ok: false, status: 429, body: null };
    }),
  );
  assert.equal(calls, 2);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.httpStatus, 429);
});

test('Jira Automation does not retry a 4xx, because retrying a wrong rule is just noise', async () => {
  let calls = 0;
  const outcome = await sendAutomation(
    automationConnection,
    AUTOMATION_NOTIFICATION,
    transportWith(async () => {
      calls++;
      return { ok: false, status: 404, body: null };
    }),
  );
  assert.equal(calls, 1);
  assert.equal(outcome.httpStatus, 404);
  assert.equal(outcome.attempts, 1);
});

test('a Jira Automation network error is retried and then reported, never thrown', async () => {
  let calls = 0;
  const outcome = await sendAutomation(automationConnection, AUTOMATION_NOTIFICATION, async () => {
    calls++;
    throw new Error('ECONNREFUSED');
  });
  assert.equal(calls, 2);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.httpStatus, null);
  assert.match(outcome.error, /ECONNREFUSED/);
  assert.equal(outcome.attempts, 2);
});

test('Jira Automation rejects misspelled event filters before saving a webhook', () => {
  const secret = (key) => key === 'url' ? 'https://automation.atlassian.com/pro/hooks/abc' : null;
  assert.doesNotThrow(() => jiraAutomationProvider.validateConfig({ eventKinds: 'error,finished' }, secret));
  assert.throws(
    () => jiraAutomationProvider.validateConfig({ eventKinds: 'finishd' }, secret),
    /Unsupported event kind: finishd/,
  );
  const connection = (eventKinds) => ({ record: { config: { eventKinds } } });
  const notification = { kind: 'finished' };
  assert.equal(jiraAutomationProvider.acceptsNotification(connection('error'), notification), false);
  assert.equal(jiraAutomationProvider.acceptsNotification(connection('error,finished'), notification), true);
});
