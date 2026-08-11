import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import {
  assertPublicDeliveryTarget,
  buildRequest,
  deliver,
  isPublicAddress,
} from '../dist/api/delivery.js';
import { notificationProviders } from '../dist/api/notification-providers.js';

const NOTIFICATION = {
  id: 'n1',
  workspaceId: 'ws1',
  repo: 'acme/app',
  kind: 'action_required',
  title: 'Pull request needs a decision',
  body: 'PR #12 scored 82 on slop detection.',
  href: '#/slop/slop-abc',
  readAt: null,
  createdAt: 1_700_000_000_000,
};

// ---------- payload shapes ----------

test('slack gets a text field', () => {
  const req = buildRequest('slack', 'https://hooks.slack.com/x', NOTIFICATION);
  const body = JSON.parse(req.body);
  assert.match(body.text, /Pull request needs a decision/);
  assert.match(body.text, /slop detection/);
});

test('discord gets a content field, clipped under the platform limit', () => {
  const long = { ...NOTIFICATION, body: 'x'.repeat(5000) };
  const body = JSON.parse(buildRequest('discord', 'https://discord.com/api/webhooks/x', long).body);
  assert.ok(body.content.length <= 1900);
});

test('ntfy posts to the origin with the topic taken from the path', () => {
  const req = buildRequest('ntfy', 'https://ntfy.sh/my-topic', NOTIFICATION);
  // The topic travels in the body, not a header, so a non-ASCII title needs no
  // hand-rolled encoding.
  assert.equal(req.url, 'https://ntfy.sh');
  const body = JSON.parse(req.body);
  assert.equal(body.topic, 'my-topic');
  assert.equal(body.title, NOTIFICATION.title);
});

test('teams gets an adaptive card in a message attachment envelope', () => {
  const req = buildRequest('teams', 'https://acme.webhook.office.com/webhookb2/x', NOTIFICATION, {
    publicUrl: 'https://companion.corp',
  });
  const body = JSON.parse(req.body);
  assert.equal(body.type, 'message');
  assert.equal(body.attachments.length, 1);
  const [attachment] = body.attachments;
  assert.equal(attachment.contentType, 'application/vnd.microsoft.card.adaptive');
  assert.equal(attachment.content.type, 'AdaptiveCard');
  assert.equal(attachment.content.body[0].text, NOTIFICATION.title);
  assert.match(attachment.content.body[1].text, /slop detection/);
  assert.equal(attachment.content.actions[0].type, 'Action.OpenUrl');
  assert.equal(attachment.content.actions[0].url, 'https://companion.corp/#/slop/slop-abc');
});

test('a teams card without a public URL carries no open action', () => {
  const body = JSON.parse(buildRequest('teams', 'https://acme.webhook.office.com/webhookb2/x', NOTIFICATION).body);
  assert.equal(body.attachments[0].content.actions, undefined);
});

test('a webhook carries the whole record', () => {
  const body = JSON.parse(buildRequest('webhook', 'https://example.com/hook', NOTIFICATION).body);
  assert.equal(body.id, 'n1');
  assert.equal(body.kind, 'action_required');
  assert.equal(body.repo, 'acme/app');
});

// ---------- links ----------

test('with no public URL configured, no link is invented', () => {
  const body = JSON.parse(buildRequest('slack', 'https://hooks.slack.com/x', NOTIFICATION).body);
  assert.doesNotMatch(body.text, /http/);
});

test('a configured public URL produces an absolute link, with no doubled slash', () => {
  const req = buildRequest('slack', 'https://hooks.slack.com/x', NOTIFICATION, {
    publicUrl: 'https://companion.corp/',
  });
  assert.match(JSON.parse(req.body).text, /https:\/\/companion\.corp\/#\/slop\/slop-abc/);
});

// ---------- signing ----------

test('a signed webhook signs the exact bytes it sends', () => {
  const req = buildRequest('webhook', 'https://example.com/hook', NOTIFICATION, { secret: 's3cret' });
  const expected = `sha256=${createHmac('sha256', 's3cret').update(req.body).digest('hex')}`;
  assert.equal(req.headers['x-companion-signature-256'], expected);
});

test('an unsigned webhook carries no signature header at all', () => {
  const req = buildRequest('webhook', 'https://example.com/hook', NOTIFICATION);
  assert.equal(req.headers['x-companion-signature-256'], undefined);
});

test('a secret set on a non-webhook kind never leaks into its request', () => {
  const req = buildRequest('slack', 'https://hooks.slack.com/x', NOTIFICATION, { secret: 's3cret' });
  assert.doesNotMatch(JSON.stringify(req), /s3cret/);
});

// ---------- delivery ----------

const REQUEST = { url: 'https://example.com/hook', headers: {}, body: '{}' };

test('provider connections reject unsafe destinations before a secret is stored', () => {
  const providers = new Map(notificationProviders(() => null).map((provider) => [provider.descriptor.id, provider]));
  const validate = (providerId, url) => providers.get(providerId).validateConfig({}, () => url);

  assert.throws(() => validate('slack.webhook', 'http://hooks.slack.com/services/T/B/X'), /Slack webhooks must use HTTPS/);
  assert.throws(() => validate('slack.webhook', 'https://hooks.slack.test/services/T/B/X'), /official hooks\.slack\.com/);
  assert.doesNotThrow(() => validate('slack.webhook', 'https://hooks.slack.com/services/T/B/X'));
  assert.throws(() => validate('discord.webhook', 'https://example.test/api/webhooks/1/token'), /official discord\.com/);
  assert.doesNotThrow(() => validate('discord.webhook', 'https://discord.com/api/webhooks/1/token'));
  assert.throws(() => validate('discord.webhook', 'file:///tmp/hook'), /must use HTTP\(S\)/);
  assert.throws(() => validate('webhook.generic', 'https://user:pass@example.test/hook'), /embedded credentials/);
  assert.doesNotThrow(() => validate('webhook.generic', 'http://internal.example.test/hook'));
  assert.throws(() => validate('teams.webhook', 'http://acme.webhook.office.com/webhookb2/a/IncomingWebhook/b/c'), /must use HTTPS/);
  assert.throws(() => validate('teams.webhook', 'https://evil.example/webhookb2/a/IncomingWebhook/b/c'), /Teams webhook must be/);
  assert.throws(
    () => validate('teams.webhook', 'https://acme.webhook.office.com.evil.example/webhookb2/a/IncomingWebhook/b/c'),
    /Teams webhook must be/,
  );
  assert.throws(() => validate('teams.webhook', 'https://acme.webhook.office.com/other/path'), /Teams webhook must be/);
  assert.throws(() => validate('teams.webhook', 'https://prod-27.westus.logic.azure.com/other/path'), /Teams webhook must be/);
  assert.doesNotThrow(() => validate('teams.webhook', 'https://acme.webhook.office.com/webhookb2/a@b/IncomingWebhook/c/d'));
  assert.doesNotThrow(
    () => validate('teams.webhook', 'https://prod-27.westus.logic.azure.com/workflows/abc/triggers/manual/paths/invoke?sig=x'),
  );
});

test('provider connections reject misspelled notification filters before storage', () => {
  const [slack] = notificationProviders(() => null);
  const secret = (key) => key === 'url' ? 'https://hooks.slack.com/services/T/B/X' : null;
  assert.doesNotThrow(() => slack.validateConfig({ eventKinds: 'error,finished' }, secret));
  assert.throws(
    () => slack.validateConfig({ eventKinds: 'finishd' }, secret),
    /Unsupported event kind: finishd/,
  );
});

test('a 2xx is one attempt and done', async () => {
  let calls = 0;
  const outcome = await deliver(REQUEST, async () => {
    calls++;
    return { ok: true, status: 204, statusText: 'No Content' };
  });
  assert.deepEqual(outcome, { ok: true, httpStatus: 204, error: null, attempts: 1 });
  assert.equal(calls, 1);
});

test('a 404 is not retried, because retrying a wrong URL is just noise', async () => {
  let calls = 0;
  const outcome = await deliver(REQUEST, async () => {
    calls++;
    return { ok: false, status: 404, statusText: 'Not Found' };
  });
  assert.equal(calls, 1);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.httpStatus, 404);
});

test('a 503 is retried once and can succeed on the second attempt', async () => {
  let calls = 0;
  const outcome = await deliver(REQUEST, async () => {
    calls++;
    return calls === 1
      ? { ok: false, status: 503, statusText: 'Service Unavailable' }
      : { ok: true, status: 200, statusText: 'OK' };
  });
  assert.equal(calls, 2);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.attempts, 2);
});

test('rate limiting is treated as transient', async () => {
  let calls = 0;
  await deliver(REQUEST, async () => {
    calls++;
    return { ok: false, status: 429, statusText: 'Too Many Requests' };
  });
  assert.equal(calls, 2);
});

test('a network error is retried and then reported, never thrown', async () => {
  let calls = 0;
  const outcome = await deliver(REQUEST, async () => {
    calls++;
    throw new Error('ECONNREFUSED');
  });
  assert.equal(calls, 2);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.httpStatus, null);
  assert.match(outcome.error, /ECONNREFUSED/);
});

test('built-in targets cannot resolve to local, private, metadata, transition, or reserved addresses', async () => {
  for (const address of [
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '192.168.1.2',
    '240.0.0.1',
    '255.255.255.255',
    '::1',
    '::ffff:127.0.0.1',
    '64:ff9b:1::7f00:1',
    '100::1',
    '2002:7f00:1::',
    'fc00::1',
    '2001:db8::1',
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress('1.1.1.1'), true);
  await assert.rejects(assertPublicDeliveryTarget('http://localhost/hook'), /publicly reachable/);
  await assert.rejects(
    assertPublicDeliveryTarget('https://notifications.example/hook', async () => ['10.0.0.4']),
    /public addresses/,
  );
  await assert.rejects(
    assertPublicDeliveryTarget('https://notifications.example/hook', async () => ['93.184.216.34', '127.0.0.1']),
    /public addresses/,
  );
});

test('built-in delivery validates DNS and never follows redirects', async () => {
  let calls = 0;
  const outcome = await deliver(
    REQUEST,
    async (_url, init) => {
      calls++;
      assert.equal(init.redirect, 'manual');
      return { ok: true, status: 204, statusText: 'No Content' };
    },
    { publicOnly: true, resolveAddresses: async () => ['93.184.216.34'] },
  );
  assert.equal(outcome.ok, true);
  assert.equal(calls, 1);
});

test('a built-in destination targeting a private service fails before fetch', async () => {
  let calls = 0;
  const outcome = await deliver(
    REQUEST,
    async () => {
      calls++;
      return { ok: true, status: 200, statusText: 'OK' };
    },
    { publicOnly: true, resolveAddresses: async () => ['169.254.169.254'] },
  );
  assert.equal(outcome.ok, false);
  assert.equal(calls, 0);
  assert.match(outcome.error, /public addresses/);
});
