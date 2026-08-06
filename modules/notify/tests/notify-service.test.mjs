import assert from 'node:assert/strict';
import test from 'node:test';
import { NotifyService } from '../dist/api/notify-service.js';

const connection = {
  record: {
    id: 'ic-slack',
    providerId: 'slack.webhook',
    name: 'Engineering Slack',
    ownerId: null,
    scope: { kind: 'instance' },
    config: {},
  },
  secret: () => null,
};
const target = {
  ref: { providerId: 'slack.webhook', connectionId: 'ic-slack' },
  provider: {
    descriptor: {
      id: 'slack.webhook',
      title: 'Slack incoming webhook',
    },
  },
  connection,
};

test('notification fan-out uses integration scope and records provider-neutral history', async () => {
  const history = [];
  const broadcasts = [];
  let matched;
  const integrations = {
    matchingConnections: (capability, scope, ownerId) => {
      matched = { capability, scope, ownerId };
      return [target];
    },
    deliverNotification: async () => ({ ok: true, httpStatus: 204, error: null, attempts: 1 }),
  };
  const store = {
    logDelivery: (entry, scope, ownerId) => history.push({ ...entry, scope, ownerId }),
    deliveriesForScopes: () => history,
  };
  const notify = new NotifyService(store, integrations, () => 'https://companion.example', (message) => broadcasts.push(message));

  await notify.fanOut({
    id: 'notice-1',
    workspaceId: 'ws-1',
    userId: null,
    repo: 'acme/app',
    kind: 'finished',
    title: 'Review finished',
    body: 'PR #7 is ready.',
    href: '#/repos/acme/app/prs/7',
    readAt: null,
    createdAt: 1,
  });

  assert.deepEqual(matched, {
    capability: 'notifications',
    scope: { kind: 'repository', workspaceId: 'ws-1', repo: 'acme/app' },
    ownerId: null,
  });
  assert.equal(history.length, 1);
  assert.equal(history[0].connectionId, 'ic-slack');
  assert.equal(history[0].providerId, 'slack.webhook');
  assert.equal(history[0].connectionName, 'Engineering Slack');
  assert.equal(history[0].status, 'delivered');
  assert.deepEqual(broadcasts, [{ t: 'notify.changed' }]);
});

test('delivery history uses immutable delivery scopes and ownership', () => {
  const store = {
    deliveriesForScopes: (scopes, viewer) => [{ id: 'one', scopes, viewer }],
  };
  const notify = new NotifyService(store, {}, () => null, () => undefined);

  const scopes = [{ kind: 'instance' }, { kind: 'workspace', workspaceId: 'ws-1' }];
  assert.deepEqual(notify.deliveriesFor('alice', scopes), [{ id: 'one', scopes, viewer: 'alice' }]);
});

test('provider-owned filters skip delivery and do not create false history', async () => {
  let deliveries = 0;
  const integrations = {
    matchingConnections: () => [{
      ...target,
      provider: { ...target.provider, acceptsNotification: () => false },
    }],
    deliverNotification: async () => {
      deliveries++;
      return { ok: true, httpStatus: 204, error: null, attempts: 1 };
    },
  };
  const history = [];
  const broadcasts = [];
  const notify = new NotifyService(
    { logDelivery: (entry) => history.push(entry), deliveriesForScopes: () => history },
    integrations,
    () => null,
    (message) => broadcasts.push(message),
  );

  await notify.fanOut({
    id: 'notice-filtered',
    workspaceId: 'ws-1',
    userId: null,
    repo: 'acme/app',
    kind: 'info',
    title: 'Routine update',
    body: 'Nothing needs attention.',
    href: null,
    readAt: null,
    createdAt: 2,
  });

  assert.equal(deliveries, 0);
  assert.deepEqual(history, []);
  assert.deepEqual(broadcasts, []);
});
