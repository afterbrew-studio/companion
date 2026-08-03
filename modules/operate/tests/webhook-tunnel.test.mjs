import assert from 'node:assert/strict';
import test from 'node:test';
import { WebhookTunnel } from '../dist/api/webhook-tunnel.js';

test('tunnel surfaces a failed registration and recovers on retry', async () => {
  let enabled = true;
  let attempts = 0;
  let closed = false;
  const states = [];
  const createTunnel = () => ({
    open: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('proxy: control connection closed before registration');
      return {
        url: 'https://test.proxy.moxxy.ai/gh',
        close: async () => {
          closed = true;
        },
      };
    },
  });
  const tunnel = new WebhookTunnel(
    () => enabled,
    () => '',
    8901,
    () => states.push(tunnel.state().status),
    createTunnel,
  );

  await assert.rejects(() => tunnel.start(), /closed before registration/);
  assert.deepEqual(tunnel.state(), {
    enabled: true,
    source: 'relay',
    status: 'error',
    url: null,
    error: 'The moxxy relay closed the connection before it was ready. Retrying automatically.',
  });

  assert.equal(await tunnel.start(), 'https://test.proxy.moxxy.ai/gh');
  assert.equal(tunnel.state().status, 'connected');
  assert.equal(attempts, 2);

  enabled = false;
  await tunnel.stop();
  assert.equal(closed, true);
  assert.deepEqual(tunnel.state(), { enabled: false, source: 'off', status: 'off', url: null, error: null });
  assert.ok(states.includes('connecting'));
  assert.ok(states.includes('error'));
  assert.ok(states.includes('connected'));
});

test('a self-managed URL takes precedence without opening the relay', async () => {
  let opened = 0;
  const tunnel = new WebhookTunnel(
    () => true,
    () => 'https://companion.example.com/engineering/',
    8901,
    () => undefined,
    () => ({
      open: async () => {
        opened += 1;
        throw new Error('relay should not open');
      },
    }),
  );

  assert.equal(await tunnel.start(), 'https://companion.example.com/engineering');
  assert.equal(opened, 0);
  assert.equal(
    tunnel.deliveryUrl('/webhooks/github/acme/repo'),
    'https://companion.example.com/engineering/webhooks/github/acme/repo',
  );
  assert.deepEqual(tunnel.state(), {
    enabled: true,
    source: 'external',
    status: 'connected',
    url: 'https://companion.example.com/engineering',
    error: null,
  });
});

test('an invalid self-managed URL fails visibly instead of falling back silently', () => {
  const tunnel = new WebhookTunnel(() => true, () => 'file:///tmp/socket', 8901);
  assert.equal(tunnel.enabled(), false);
  assert.deepEqual(tunnel.state(), {
    enabled: true,
    source: 'external',
    status: 'error',
    url: null,
    error: 'The self-managed webhook URL must use HTTPS (HTTP is allowed only on loopback) and have no credentials, query, or fragment.',
  });
});

test('self-managed ingress refuses cleartext public hosts but permits loopback development', async () => {
  const publicHttp = new WebhookTunnel(() => false, () => 'http://companion.example.com', 8901);
  assert.equal(publicHttp.enabled(), false);
  assert.match(publicHttp.state().error ?? '', /must use HTTPS/);

  const localHttp = new WebhookTunnel(() => false, () => 'http://127.0.0.1:8901/hooks/', 8901);
  assert.equal(await localHttp.start(), 'http://127.0.0.1:8901/hooks');
  assert.equal(localHttp.state().source, 'external');
});
