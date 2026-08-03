import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { RawRouter, rawRoute } from '../dist/server/raw-router.js';

function request(path, body) {
  const req = Readable.from([body]);
  req.method = 'POST';
  req.url = path;
  req.headers = {};
  return req;
}

function response() {
  const result = { status: null, headers: null, body: null };
  return {
    result,
    res: {
      writeHead: (status, headers) => {
        result.status = status;
        result.headers = headers;
      },
      end: (body) => {
        result.body = body;
      },
    },
  };
}

test('raw routes preserve the byte reader 413 instead of misreporting it as a bad request', async () => {
  const router = new RawRouter({ warn() {} });
  router.mount('webhooks', [
    rawRoute({
      method: 'POST',
      path: '/hook',
      maxBytes: 4,
      handler: () => ({ status: 202, body: 'accepted' }),
    }),
  ]);
  const { res, result } = response();

  assert.equal(await router.tryDispatch(request('/hook', Buffer.from('12345')), res), true);
  assert.equal(result.status, 413);
  assert.equal(result.body, 'payload too large');
});

test('raw routes do not expose arbitrary internal errors to unauthenticated callers', async () => {
  const router = new RawRouter({ warn() {} });
  router.mount('webhooks', [
    rawRoute({
      method: 'POST',
      path: '/hook',
      handler: () => { throw new Error('SQL failed near super_secret_table'); },
    }),
  ]);
  const { res, result } = response();

  assert.equal(await router.tryDispatch(request('/hook', Buffer.from('{}')), res), true);
  assert.equal(result.status, 500);
  assert.equal(result.body, 'raw route failed');
});

test('malformed encoded webhook paths are a bounded 400, not an unhandled rejection', async () => {
  const router = new RawRouter({ warn() {} });
  router.mount('webhooks', [
    rawRoute({
      method: 'POST',
      path: '/hook/:repo',
      handler: () => ({ status: 202, body: 'accepted' }),
    }),
  ]);
  const { res, result } = response();

  assert.equal(await router.tryDispatch(request('/hook/%E0%A4%A', Buffer.from('{}')), res), true);
  assert.equal(result.status, 400);
  assert.equal(result.body, 'malformed path parameter');
});
