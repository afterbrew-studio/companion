import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import WebSocket from 'ws';
import { WsHub } from '../dist/server/index.js';

test('SPA websocket authenticates with the HttpOnly cookie, never a query token', async (t) => {
  const hub = new WsHub(
    (token) => token === 'session-secret' ? { username: 'admin', displayName: 'Admin', role: 'admin' } : null,
    'test',
  );
  const server = createServer((_req, res) => res.end());
  server.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  t.after(() => {
    hub.close();
    server.close();
  });

  const hello = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { origin, cookie: 'companion.session=session-secret' },
    });
    ws.once('message', (data) => {
      resolve(JSON.parse(String(data)));
      ws.close();
    });
    ws.once('error', reject);
  });
  assert.deepEqual(hello, { t: 'hello', version: 'test' });

  const status = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=session-secret`, { headers: { origin } });
    ws.once('unexpected-response', (_request, response) => resolve(response.statusCode));
    ws.once('open', () => reject(new Error('query token unexpectedly authenticated')));
    ws.once('error', () => undefined);
  });
  assert.equal(status, 401);
});

test('a frame above 1 MiB closes the socket instead of being buffered', async (t) => {
  const hub = new WsHub(
    (token) => token === 'session-secret' ? { username: 'admin', displayName: 'Admin', role: 'admin' } : null,
    'test',
  );
  const server = createServer((_req, res) => res.end());
  server.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  t.after(() => {
    hub.close();
    server.close();
  });

  const closeCode = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { origin, cookie: 'companion.session=session-secret' },
    });
    ws.once('open', () => ws.send(Buffer.alloc(1024 * 1024 + 1)));
    ws.once('close', (code) => resolve(code));
    ws.once('error', () => undefined);
  });
  // 1009 = message too big: the hub's maxPayload rejected the frame.
  assert.equal(closeCode, 1009);
});
