import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { AuditForwarder } from '../dist/api/audit-forwarder.js';

const event = (n) => ({ at: 1_700_000_000_000 + n, actor: 'alice', action: `POST /api/thing/${n}`, access: 'x:y', status: 200, module: 'core' });

function forwarder({ url = 'https://collector.test/audit', secret = null, respond } = {}) {
  const calls = [];
  const impl = async (target, init) => {
    calls.push({ target, headers: init.headers, body: init.body });
    return respond ? respond(calls.length) : { ok: true, status: 204, statusText: 'No Content' };
  };
  return { calls, f: new AuditForwarder(() => ({ url, secret }), () => {}, impl) };
}

test('with no collector configured, nothing is buffered and nothing is sent', async () => {
  const { calls, f } = forwarder({ url: null });
  f.enqueue(event(1));
  await f.flush();
  assert.equal(calls.length, 0);
  assert.equal(f.state().buffered, 0);
  assert.equal(f.state().configured, false);
});

test('a batch ships as NDJSON, one entry per line', async () => {
  const { calls, f } = forwarder();
  f.enqueue(event(1));
  f.enqueue(event(2));
  await f.flush();
  assert.equal(calls.length, 1);
  const lines = calls[0].body.trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).action, 'POST /api/thing/1');
  assert.equal(calls[0].headers['content-type'], 'application/x-ndjson');
});

test('a signing secret signs the exact bytes sent', async () => {
  const { calls, f } = forwarder({ secret: 's3cret' });
  f.enqueue(event(1));
  await f.flush();
  const expected = `sha256=${createHmac('sha256', 's3cret').update(calls[0].body).digest('hex')}`;
  assert.equal(calls[0].headers['x-companion-signature-256'], expected);
});

test('no secret means no signature header at all', async () => {
  const { calls, f } = forwarder();
  f.enqueue(event(1));
  await f.flush();
  assert.equal(calls[0].headers['x-companion-signature-256'], undefined);
});

test('a failed batch is retried in its original order, not dropped or reversed', async () => {
  // An audit stream that silently reorders is worse than one with a visible gap.
  const { calls, f } = forwarder({
    respond: (n) => (n === 1 ? { ok: false, status: 503, statusText: 'Unavailable' } : { ok: true, status: 204, statusText: '' }),
  });
  f.enqueue(event(1));
  f.enqueue(event(2));
  await f.flush();
  assert.equal(f.state().buffered, 2, 'the batch goes back into the buffer');
  await f.flush();
  const lines = calls[1].body.trimEnd().split('\n');
  assert.equal(JSON.parse(lines[0]).action, 'POST /api/thing/1');
  assert.equal(JSON.parse(lines[1]).action, 'POST /api/thing/2');
  assert.equal(f.state().buffered, 0);
});

test('a failure is reported in the state rather than thrown', async () => {
  const { f } = forwarder({ respond: () => ({ ok: false, status: 500, statusText: 'Boom' }) });
  f.enqueue(event(1));
  await assert.doesNotReject(() => f.flush());
  assert.match(f.state().lastError, /500/);
});

test('a network error is caught the same way', async () => {
  const f = new AuditForwarder(
    () => ({ url: 'https://collector.test/audit', secret: null }),
    () => {},
    async () => {
      throw new Error('ECONNREFUSED');
    },
  );
  f.enqueue(event(1));
  await assert.doesNotReject(() => f.flush());
  assert.match(f.state().lastError, /ECONNREFUSED/);
  assert.equal(f.state().buffered, 1);
});

test('a recovered collector clears the error', async () => {
  const { f } = forwarder({
    respond: (n) => (n === 1 ? { ok: false, status: 503, statusText: '' } : { ok: true, status: 204, statusText: '' }),
  });
  f.enqueue(event(1));
  await f.flush();
  assert.notEqual(f.state().lastError, null);
  await f.flush();
  assert.equal(f.state().lastError, null);
  assert.notEqual(f.state().lastDeliveryAt, null);
});

test('a dead collector costs bounded memory and counts what it dropped', async () => {
  // The table is the source of truth and export can backfill, which is what makes
  // dropping the honest choice over growing until the daemon dies.
  //
  // Asserted as a BOUND, not an exact count. `enqueue` kicks an early flush that
  // splices its batch out synchronously, so the precise split between shipped,
  // buffered and dropped depends on async interleaving. That is an implementation
  // detail; "never unbounded" is the property.
  const { f } = forwarder({ respond: () => ({ ok: false, status: 503, statusText: '' }) });
  for (let i = 0; i < 20_000; i++) f.enqueue(event(i));
  assert.ok(f.state().buffered <= 5_000, `buffered ${f.state().buffered} exceeded the cap`);
  assert.ok(f.state().dropped > 0, 'far more than the cap was enqueued, so something must have been dropped');
});

test('overflow drops from the front, so the newest entries survive', async () => {
  const { calls, f } = forwarder({ respond: () => ({ ok: false, status: 503, statusText: '' }) });
  for (let i = 0; i < 20_000; i++) f.enqueue(event(i));
  // Let the failed in-flight batch settle back into the buffer, then ship.
  await new Promise((resolve) => setImmediate(resolve));
  const before = calls.length;
  await f.flush();
  assert.ok(calls.length > before);
  const shipped = calls[calls.length - 1].body.trimEnd().split('\n').map((l) => JSON.parse(l).at);
  const newest = 1_700_000_000_000 + 19_999;
  assert.ok(
    Math.max(...shipped) > newest - 10_000,
    'the retained window must be the recent end of the stream, not the start',
  );
});

test('enqueue never touches the network, so the request path pays nothing', () => {
  const { calls, f } = forwarder();
  f.enqueue(event(1));
  assert.equal(calls.length, 0, 'only the timer or an explicit flush ships anything');
});
