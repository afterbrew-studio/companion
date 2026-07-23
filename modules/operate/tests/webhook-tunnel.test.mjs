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
    8901,
    () => states.push(tunnel.state().status),
    createTunnel,
  );

  await assert.rejects(() => tunnel.start(), /closed before registration/);
  assert.deepEqual(tunnel.state(), {
    enabled: true,
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
  assert.deepEqual(tunnel.state(), { enabled: false, status: 'off', url: null, error: null });
  assert.ok(states.includes('connecting'));
  assert.ok(states.includes('error'));
  assert.ok(states.includes('connected'));
});
