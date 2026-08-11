import assert from 'node:assert/strict';
import test from 'node:test';
import { MetricsRegistry } from '@moxxy/companion-core/server';
import { metricsRequestAllowed, startHttpServer } from '../dist/http/server.js';

async function serve(t, kernel, hub = { handleUpgrade() {} }) {
  const server = await startHttpServer({
    host: '127.0.0.1',
    port: 0,
    authMode: 'password',
    kernel,
    hub,
  });
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

function withEnv(t, key, value) {
  const before = process.env[key];
  process.env[key] = value;
  t.after(() => {
    if (before === undefined) delete process.env[key];
    else process.env[key] = before;
  });
}

test('metrics are disabled by default', async (t) => {
  const base = await serve(t, { rawRouter: { active: false } });
  const response = await fetch(`${base}/metrics`);
  assert.equal(response.status, 404);
});

test('loopback scrapes serve the exposition without any credential', async (t) => {
  withEnv(t, 'COMPANION_METRICS', '1');
  const metrics = new MetricsRegistry();
  metrics.counter('companion_http_requests_total', 'requests').inc({ route: 'GET /api/x', status: '2xx' });
  const base = await serve(
    t,
    { rawRouter: { active: false }, metrics, readiness: () => ({ ready: true, modules: [] }) },
    { handleUpgrade() {}, connectionCount: () => 3 },
  );

  const response = await fetch(`${base}/metrics`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^text\/plain; version=0\.0\.4/);
  const body = await response.text();
  assert.match(body, /companion_ws_connections 3\n/);
  assert.match(body, /companion_http_requests_total\{route="GET \/api\/x",status="2xx"\} 1\n/);
  assert.match(body, /process_resident_memory_bytes \d+/);
  assert.match(body, /nodejs_eventloop_lag_seconds/);
});

test('non-loopback scrapes fail closed without the exact bearer token', () => {
  // No token configured: every remote scrape is refused.
  assert.equal(metricsRequestAllowed('203.0.113.5', undefined, undefined), false);
  assert.equal(metricsRequestAllowed('203.0.113.5', 'Bearer anything', undefined), false);
  // Token configured: only the exact bearer passes.
  assert.equal(metricsRequestAllowed('203.0.113.5', undefined, 's3cret'), false);
  assert.equal(metricsRequestAllowed('203.0.113.5', 'Bearer wrong', 's3cret'), false);
  assert.equal(metricsRequestAllowed('203.0.113.5', 's3cret', 's3cret'), false);
  assert.equal(metricsRequestAllowed('203.0.113.5', 'Bearer s3cret', 's3cret'), true);
  // Loopback stays credential-free, mapped form included.
  assert.equal(metricsRequestAllowed('127.0.0.1', undefined, undefined), true);
  assert.equal(metricsRequestAllowed('::ffff:127.0.0.1', undefined, 's3cret'), true);
  // An absent peer address never passes.
  assert.equal(metricsRequestAllowed(undefined, 'Bearer s3cret', undefined), false);
});

test('readyz mirrors kernel readiness with module states and no config', async (t) => {
  const ready = {
    ready: true,
    modules: [
      { id: 'core', state: 'enabled' },
      { id: 'extra', state: 'available' },
    ],
  };
  const base = await serve(t, { rawRouter: { active: false }, readiness: () => ready });

  const response = await fetch(`${base}/readyz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), ready);
});

test('the server carries explicit timeouts instead of Node defaults', async (t) => {
  const server = await startHttpServer({
    host: '127.0.0.1',
    port: 0,
    authMode: 'password',
    kernel: { rawRouter: { active: false } },
    hub: { handleUpgrade() {} },
  });
  t.after(() => server.close());

  assert.equal(server.requestTimeout, 300_000);
  assert.equal(server.headersTimeout, 60_000);
  assert.equal(server.keepAliveTimeout, 65_000);
});

test('readyz answers 503 while not ready', async (t) => {
  const base = await serve(t, {
    rawRouter: { active: false },
    readiness: () => ({ ready: false, modules: [{ id: 'flaky', state: 'failed' }] }),
  });

  const response = await fetch(`${base}/readyz`);
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.ready, false);
  assert.deepEqual(body.modules, [{ id: 'flaky', state: 'failed' }]);
});
