import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { DynamicRouter, MetricsRegistry, route } from '../dist/server/index.js';

const log = { info() {}, warn() {}, error() {}, debug() {} };

test('counters accumulate per label set and render in exposition format', () => {
  const registry = new MetricsRegistry();
  const requests = registry.counter('companion_http_requests_total', 'HTTP requests');
  requests.inc({ route: 'GET /api/x', status: '2xx' });
  requests.inc({ route: 'GET /api/x', status: '2xx' });
  requests.inc({ route: 'GET /api/x', status: '5xx' });

  const body = registry.render();
  assert.match(body, /# HELP companion_http_requests_total HTTP requests\n/);
  assert.match(body, /# TYPE companion_http_requests_total counter\n/);
  assert.match(body, /companion_http_requests_total\{route="GET \/api\/x",status="2xx"\} 2\n/);
  assert.match(body, /companion_http_requests_total\{route="GET \/api\/x",status="5xx"\} 1\n/);
});

test('re-registering a counter returns the same series instead of resetting', () => {
  const registry = new MetricsRegistry();
  registry.counter('jobs_total', 'jobs').inc();
  registry.counter('jobs_total', 'jobs').inc();
  assert.match(registry.render(), /jobs_total 2\n/);
});

test('gauges sample their collector at scrape time', () => {
  const registry = new MetricsRegistry();
  let open = 1;
  registry.gauge('ws_connections', 'open sockets', () => open);
  assert.match(registry.render(), /# TYPE ws_connections gauge\n(.*\n)*ws_connections 1\n/);
  open = 7;
  assert.match(registry.render(), /ws_connections 7\n/);
});

test('a throwing collector skips its sample without killing the scrape', () => {
  const registry = new MetricsRegistry();
  registry.gauge('broken', 'boom', () => {
    throw new Error('boom');
  });
  registry.counter('fine_total', 'still here').inc();
  const body = registry.render();
  assert.doesNotMatch(body, /^broken \d/m);
  assert.match(body, /fine_total 1\n/);
});

test('label values are escaped and a kind clash throws', () => {
  const registry = new MetricsRegistry();
  registry.counter('odd_total', 'odd').inc({ label: 'quote " backslash \\ newline \n end' });
  assert.match(registry.render(), /odd_total\{label="quote \\" backslash \\\\ newline \\n end"\} 1\n/);
  assert.throws(() => registry.gauge('odd_total', 'clash', () => 0), /already registered as a counter/);
});

test('the router reports each answered request by pattern and status', async (t) => {
  const observed = [];
  const router = new DynamicRouter(
    { verify: () => null, require: () => {} },
    log,
    () => {},
    { observe: (routePattern, method, status) => observed.push([`${method} ${routePattern}`, status]) },
  );
  router.mount('probe', [
    route({
      method: 'GET',
      path: '/api/things/:id',
      access: 'public',
      handler: ({ params }) => ({ id: params.id }),
    }),
  ]);
  const server = createServer((req, res) => void router.dispatch(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  assert.equal((await fetch(`${base}/api/things/42`)).status, 200);
  assert.equal((await fetch(`${base}/api/things/43`)).status, 200);
  assert.equal((await fetch(`${base}/nope`)).status, 404);

  // The PATTERN, not the concrete path: cardinality must not grow per id.
  assert.deepEqual(observed, [
    ['GET /api/things/:id', 200],
    ['GET /api/things/:id', 200],
    ['GET (unmatched)', 404],
  ]);
});
