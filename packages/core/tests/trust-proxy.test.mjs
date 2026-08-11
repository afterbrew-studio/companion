import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  clientAddressFrom,
  DynamicRouter,
  isLoopbackAddress,
  route,
  TrustedProxies,
} from '../dist/server/index.js';

const log = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * End-to-end through a real socket: the router derives the clientAddress the
 * handler receives, which is the same value module-core keys its login
 * throttle on. The test peer is always 127.0.0.1, so trusting or not trusting
 * that address flips the whole behaviour.
 */
async function harness(t, trustedProxies) {
  const router = new DynamicRouter(
    { verify: () => null, require: () => {} },
    log,
    () => {},
    { trustedProxies },
  );
  router.mount('probe', [
    route({
      method: 'GET',
      path: '/whoami',
      access: 'public',
      handler: ({ clientAddress }) => ({ clientAddress }),
    }),
  ]);
  const server = createServer((req, res) => void router.dispatch(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (forwardedFor) => {
    const response = await fetch(`${base}/whoami`, {
      headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
    });
    return (await response.json()).clientAddress;
  };
}

test('X-Forwarded-For from an untrusted peer is ignored entirely', async (t) => {
  const whoami = await harness(t, []);
  assert.equal(await whoami('203.0.113.7'), '127.0.0.1');
  assert.equal(await whoami(), '127.0.0.1');
});

test('a trusted peer yields the forwarded client address', async (t) => {
  const whoami = await harness(t, ['127.0.0.1']);
  assert.equal(await whoami('203.0.113.7'), '203.0.113.7');
});

test('client-prepended fake hops cannot spoof the address', async (t) => {
  // The client sent "1.2.3.4" itself; the trusted proxy appended the address
  // it actually saw. The rightmost untrusted hop wins, so the spoof is inert.
  const whoami = await harness(t, ['127.0.0.1']);
  assert.equal(await whoami('1.2.3.4, 203.0.113.7'), '203.0.113.7');
});

test('a chain of trusted proxies is walked to the first untrusted hop', async (t) => {
  const whoami = await harness(t, ['127.0.0.1', '10.0.0.0/8']);
  assert.equal(await whoami('198.51.100.9, 10.1.2.3'), '198.51.100.9');
  assert.equal(await whoami('1.2.3.4, 198.51.100.9, 10.1.2.3'), '198.51.100.9');
});

test('without X-Forwarded-For the trusted peer itself is the client', async (t) => {
  const whoami = await harness(t, ['127.0.0.1']);
  assert.equal(await whoami(), '127.0.0.1');
});

test('IPv4-mapped socket peers match IPv4 trust entries', () => {
  const trusted = new TrustedProxies(['10.0.0.0/8', '192.0.2.1']);
  assert.equal(trusted.has('::ffff:10.20.30.40'), true);
  assert.equal(trusted.has('::ffff:192.0.2.1'), true);
  assert.equal(trusted.has('::ffff:11.0.0.1'), false);
  assert.equal(trusted.has('not-an-ip'), false);
});

test('IPv6 CIDRs match and hop decorations are stripped', () => {
  const trusted = new TrustedProxies(['fd00::/8']);
  assert.equal(clientAddressFrom('fd00::1', '[2001:db8::7]:443', trusted), '2001:db8::7');
  assert.equal(clientAddressFrom('fd00::1', '203.0.113.7:8443', trusted), '203.0.113.7');
});

test('an all-trusted forwarded chain resolves to its leftmost hop', () => {
  const trusted = new TrustedProxies(['10.0.0.0/8']);
  assert.equal(clientAddressFrom('10.0.0.1', '10.9.9.9, 10.0.0.2', trusted), '10.9.9.9');
});

test('a malformed trust entry refuses to boot instead of failing open', () => {
  assert.throws(() => new TrustedProxies(['10.0.0.0/33']), /not an IP address or CIDR/);
  assert.throws(() => new TrustedProxies(['proxy.internal']), /not an IP address or CIDR/);
  assert.throws(() => new TrustedProxies(['10.0.0.0/8/1']), /not an IP address or CIDR/);
});

test('loopback detection covers IPv4, IPv6 and mapped forms', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('127.9.9.9'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('10.0.0.1'), false);
  assert.equal(isLoopbackAddress('::2'), false);
  assert.equal(isLoopbackAddress(''), false);
});
