import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertPublicHttpTarget,
  isPublicAddress,
  withPublicHttpResponse,
} from '../dist/index.js';

test('public outbound targets reject every special-purpose address, including mixed DNS answers', async () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '192.168.0.1',
    '::1',
    '::ffff:127.0.0.1',
    '64:ff9b:1::7f00:1',
    '2002:7f00:1::',
    'fc00::1',
  ]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  await assert.rejects(assertPublicHttpTarget('https://localhost/hook'), /publicly reachable/);
  await assert.rejects(
    assertPublicHttpTarget('https://hooks.example/hook', async () => ['93.184.216.34', '127.0.0.1']),
    /public addresses/,
  );
});

test('the public transport validates before invoking an injected test transport', async () => {
  let calls = 0;
  await assert.rejects(
    withPublicHttpResponse(
      'https://hooks.example/hook',
      { method: 'POST', redirect: 'manual' },
      async () => null,
      {
        resolveAddresses: async () => ['169.254.169.254'],
        fetchImpl: async () => {
          calls++;
          return new Response(null, { status: 204 });
        },
      },
    ),
    /public addresses/,
  );
  assert.equal(calls, 0);
});
