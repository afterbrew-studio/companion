import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { WebSocketServer } from 'ws';
import { GatewayClient, MOXXY_CAPABILITIES } from '../dist/exec/gateway-client.js';

/**
 * GatewayClient is the only implementation of the Harness contract, so these
 * cover both halves of it: what the capability declaration claims, and what the
 * socket actually does. The socket half runs against a real WebSocket server
 * speaking moxxy's JSON-RPC, because the failure modes worth catching (a
 * response handed to the wrong caller, an event dropped for being unfamiliar,
 * one bad frame killing the read loop) only exist on the wire.
 */

/** The five settings behind `capabilities.sessionControls`, and the method each one gates. */
const CONTROL_METHOD = {
  model: 'setModel',
  provider: 'setProvider',
  mode: 'setMode',
  autoApprove: 'setAutoApprove',
  commands: 'runCommand',
};

/** What every harness must provide, whatever its capabilities say. */
const CONTRACT = ['connect', 'close', 'runTurn', 'abortTurn', 'sessionInfo', 'loadHistory', 'respondAsk'];

/**
 * A connected client and the gateway it is talking to. Teardown is registered
 * before the first assertion runs: a failed assertion must not leave a
 * listening socket behind and hang the whole file.
 */
async function connected(t, handlers = {}, token = 'tok') {
  let offered = null;
  const received = [];
  let sock = null;

  const wss = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    handleProtocols: (protocols) => {
      offered = [...protocols];
      return 'moxxy.v1';
    },
  });
  await once(wss, 'listening');
  wss.on('connection', (ws) => {
    sock = ws;
    ws.on('message', (data) => received.push(JSON.parse(String(data))));
  });

  const client = new GatewayClient(`ws://127.0.0.1:${wss.address().port}/`, token, handlers);
  t.after(async () => {
    client.close();
    await new Promise((resolve) => wss.close(resolve));
  });
  await client.connect(3_000);

  return {
    client,
    offered: () => offered,
    send: (frame) => sock.send(JSON.stringify(frame)),
    sendRaw: (text) => sock.send(text),
    /** The request frame for `method`, waited for. */
    async request(method) {
      for (let i = 0; i < 200; i++) {
        const frame = received.find((f) => f.method === method);
        if (frame) return frame;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error(`gateway never received ${method}`);
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

// ---------- what the capability declaration claims ---------------------------

test('every session control moxxy declares is one it actually implements', () => {
  for (const [flag, method] of Object.entries(CONTROL_METHOD)) {
    const declared = MOXXY_CAPABILITIES.sessionControls[flag];
    const implemented = typeof GatewayClient.prototype[method] === 'function';
    assert.equal(
      declared,
      implemented,
      `capabilities say sessionControls.${flag}=${declared} but ${method} ${implemented ? 'exists' : 'does not exist'}`,
    );
  }
});

test('the declaration names every control it has a flag for', () => {
  // A sixth method appearing on the client with no flag beside it is how a
  // capability check silently stops covering the surface it is meant to gate.
  assert.deepEqual(
    Object.keys(MOXXY_CAPABILITIES.sessionControls).sort(),
    Object.keys(CONTROL_METHOD).sort(),
  );
});

test('moxxy answers all three axes a second harness is expected to differ on', () => {
  assert.equal(MOXXY_CAPABILITIES.approvals, 'interactive');
  assert.equal(MOXXY_CAPABILITIES.usage, 'tokens');
  assert.equal(MOXXY_CAPABILITIES.models, 'providers');
});

test('the contract surface is on the client, and every instance reports the same capabilities', () => {
  for (const name of CONTRACT) {
    assert.equal(typeof GatewayClient.prototype[name], 'function', `${name} is missing`);
  }
  const a = new GatewayClient('ws://127.0.0.1:1/', 't', {});
  const b = new GatewayClient('ws://127.0.0.1:1/', 't', {});
  assert.equal(a.capabilities, b.capabilities, 'capabilities must not be allocated per instance');
  assert.equal(a.capabilities, MOXXY_CAPABILITIES);
  assert.equal(a.isOpen, false);
});

// ---------- what the socket actually does ------------------------------------

test('the bearer token rides the subprotocol list, url-encoded', async (t) => {
  // A token that survives encoding unchanged could not tell an encoded value
  // from a raw one, so this one has to be escaped to travel at all.
  const token = 'a b/c+d%e';
  const g = await connected(t, {}, token);

  assert.deepEqual(g.offered(), ['moxxy.v1', `moxxy.bearer.${encodeURIComponent(token)}`]);
  assert.equal(g.client.isOpen, true);
  g.client.close();
  assert.equal(g.client.isOpen, false);
});

test('a response goes to the call that asked for it, not to whichever is waiting', async (t) => {
  const g = await connected(t);

  const info = g.client.sessionInfo();
  const turn = g.client.runTurn({ prompt: 'hello' });
  const infoFrame = await g.request('session.info');
  const turnFrame = await g.request('session.runTurn');

  // Answered in the opposite order to the one they were asked in: matching on
  // arrival order rather than on `id` hands each caller the other's answer.
  g.send({ id: turnFrame.id, result: { turnId: 'turn-from-runTurn' } });
  g.send({ id: infoFrame.id, result: { turnId: 'not-a-turn', which: 'session.info' } });

  assert.deepEqual(await turn, { turnId: 'turn-from-runTurn' });
  assert.deepEqual(await info, { turnId: 'not-a-turn', which: 'session.info' });
});

test('an error answer fails only the call it names', async (t) => {
  const g = await connected(t);

  const info = g.client.sessionInfo();
  const turn = g.client.runTurn({ prompt: 'hello' });
  const infoFrame = await g.request('session.info');
  const turnFrame = await g.request('session.runTurn');

  g.send({ id: infoFrame.id, error: { message: 'session.info exploded' } });
  g.send({ id: turnFrame.id, result: { turnId: 't1' } });

  await assert.rejects(info, /session\.info exploded/);
  assert.deepEqual(await turn, { turnId: 't1' });
});

test('an event type the client has never heard of reaches the transcript unchanged', async (t) => {
  const events = [];
  const g = await connected(t, { onEvent: (e) => events.push(e) });

  // Codex's vocabulary, which this client knows nothing about. A client that
  // relayed only the types it recognises would drop both of these.
  const unfamiliar = {
    id: 'x1',
    seq: 4,
    ts: 1,
    sessionId: 's',
    turnId: 't',
    source: 'model',
    type: 'item.completed',
    item: { id: 'i1', type: 'command_execution' },
  };
  g.send({ method: 'runner.event', params: { event: unfamiliar } });
  g.send({ method: 'runner.event', params: { event: { ...unfamiliar, id: 'x2', type: 'turn.failed' } } });
  await settle();

  assert.deepEqual(events[0], unfamiliar);
  assert.equal(events.length, 2);
});

test('interactive approvals means an ask actually arrives, and a malformed one does not', async (t) => {
  const asks = [];
  const g = await connected(t, { onAsk: (a) => asks.push(a) });

  const ask = { requestId: 'r1', workspaceId: 'w1', kind: 'permission', tool: { name: 'Read', input: {} } };
  g.send({ method: 'ask.request', params: ask });
  // No requestId: there would be nothing to answer, so it must not reach the UI.
  g.send({ method: 'ask.request', params: { workspaceId: 'w1', kind: 'permission' } });
  await settle();

  assert.equal(MOXXY_CAPABILITIES.approvals, 'interactive');
  assert.deepEqual(asks, [ask]);
});

test('a garbled frame does not stop the next good one', async (t) => {
  const events = [];
  const g = await connected(t, { onEvent: (e) => events.push(e) });

  g.sendRaw('{ this is not json');
  g.send({ method: 'connection.changed', params: { state: 'flapping' } }); // a channel nobody handles
  g.send({
    method: 'runner.event',
    params: { event: { id: 'a', seq: 1, ts: 1, sessionId: 's', turnId: 't', source: 'model', type: 'abort' } },
  });
  await settle();

  assert.deepEqual(events.map((e) => e.id), ['a']);
});

test('a handler that throws does not stop the next frame', async (t) => {
  const events = [];
  const g = await connected(t, {
    onEvent: (e) => {
      events.push(e);
      if (e.id === 'boom') throw new Error('handler blew up');
    },
  });

  const base = { seq: 1, ts: 1, sessionId: 's', turnId: 't', source: 'model', type: 'abort' };
  g.send({ method: 'runner.event', params: { event: { ...base, id: 'boom' } } });
  g.send({ method: 'runner.event', params: { event: { ...base, id: 'after' } } });
  await settle();

  assert.deepEqual(events.map((e) => e.id), ['boom', 'after']);
});

test('closing fails everything still in flight rather than leaving it hanging', async (t) => {
  const g = await connected(t);

  const pending = g.client.sessionInfo();
  await g.request('session.info');
  g.client.close();

  await assert.rejects(pending, /closed/);
});
