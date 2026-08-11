import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { DynamicRouter, HttpError, RawRouter, rawRoute, route } from '../dist/server/index.js';
import { claimAuditActor } from '@moxxy/companion-services';

const log = { info() {}, warn() {}, error() {}, debug() {} };
const user = { username: 'root', role: 'admin' };

async function harness(t, { verify = () => null } = {}) {
  const events = [];
  const router = new DynamicRouter(
    { verify, require: () => {} },
    log,
    (e) => events.push(e),
    { trustedProxies: ['127.0.0.1'] },
  );
  router.mount('probe', [
    route({ method: 'POST', path: '/write', access: 'any', handler: () => ({ ok: true }) }),
    route({ method: 'GET', path: '/read', access: 'any', handler: () => ({ ok: true }) }),
    route({
      method: 'POST',
      path: '/claim',
      access: 'public',
      handler: ({ query }) => {
        claimAuditActor('alice');
        if (query.get('fail')) throw new HttpError(401, 'refused');
        return { ok: true };
      },
    }),
  ]);
  const server = createServer((req, res) => void router.dispatch(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, headers = {}) =>
    fetch(`${base}${path}`, {
      method: path.startsWith('/read') ? 'GET' : 'POST',
      headers: { 'x-companion-csrf': '1', ...headers },
    });
  return { events, call };
}

test('a mutating request records the derived ip, the user agent and the actor', async (t) => {
  const { events, call } = await harness(t, { verify: () => user });
  await call('/write', { 'x-forwarded-for': '203.0.113.7', 'user-agent': 'audit-probe/1.0' });
  assert.equal(events.length, 1);
  assert.equal(events[0].actor, 'root');
  assert.equal(events[0].ip, '203.0.113.7');
  assert.equal(events[0].agent, 'audit-probe/1.0');
  assert.equal(events[0].status, 200);
});

test('a public-route handler can claim the audit actor for success and refusal', async (t) => {
  const { events, call } = await harness(t);
  await call('/claim');
  await call('/claim?fail=1');
  assert.equal(events.length, 2);
  assert.equal(events[0].actor, 'alice');
  assert.equal(events[0].status, 200);
  assert.equal(events[1].actor, 'alice');
  assert.equal(events[1].status, 401);
});

test('reads are still not audited', async (t) => {
  const { events, call } = await harness(t, { verify: () => user });
  await call('/read');
  assert.equal(events.length, 0);
});

test('raw routes record both accepted and refused deliveries with the ip', async (t) => {
  const events = [];
  const raw = new RawRouter(log, (e) => events.push(e), { trustedProxies: ['127.0.0.1'] });
  raw.mount('hooks', [
    rawRoute({
      method: 'POST',
      path: '/hook',
      handler: ({ query }) => {
        if (query.get('bad')) throw new HttpError(401, 'bad signature');
        return { status: 202, body: 'ok' };
      },
    }),
  ]);
  const server = createServer((req, res) => {
    void raw.tryDispatch(req, res).then((handled) => {
      if (!handled) (res.writeHead(404), res.end());
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  await fetch(`${base}/hook`, { method: 'POST', body: 'x', headers: { 'x-forwarded-for': '198.51.100.9' } });
  await fetch(`${base}/hook?bad=1`, { method: 'POST', body: 'x' });
  assert.equal(events.length, 2);
  assert.equal(events[0].status, 202);
  assert.equal(events[0].access, 'raw');
  assert.equal(events[0].actor, null);
  assert.equal(events[0].ip, '198.51.100.9');
  assert.equal(events[1].status, 401);
  assert.equal(events[1].ip, '127.0.0.1');
});
