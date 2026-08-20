import assert from 'node:assert/strict';
import test from 'node:test';
import {
  redactAgentAsk,
  redactAgentEvent,
  redactAgentHistory,
} from '../dist/api/redact-agent-data.js';

const token = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

test('redacts credentials from tool commands without mutating the runtime event', () => {
  const event = {
    type: 'tool_call_requested',
    seq: 1,
    ts: 1,
    source: 'model',
    callId: 'call-1',
    name: 'bash',
    input: {
      command: `curl -H 'Authorization: Bearer ${token}' https://user:password@example.test`,
      env: { API_KEY: 'secret-key', inputTokens: 42 },
    },
  };

  const redacted = redactAgentEvent(event);

  assert.match(redacted.input.command, /Bearer \[redacted\]/);
  assert.match(redacted.input.command, /user:\[redacted\]@example\.test/);
  assert.equal(redacted.input.env.API_KEY, '[redacted]');
  assert.equal(redacted.input.env.inputTokens, 42);
  assert.match(event.input.command, new RegExp(token));
  assert.equal(event.input.env.API_KEY, 'secret-key');
});

test('redacts secrets echoed inside text results and pending asks', () => {
  const output = JSON.stringify({ baseUrl: 'http://127.0.0.1', token, password: 'open-sesame' });
  const event = redactAgentEvent({
    type: 'tool_result',
    seq: 2,
    ts: 2,
    source: 'tool',
    callId: 'call-1',
    ok: true,
    output,
  });
  const ask = redactAgentAsk({
    requestId: 'ask-1',
    workspaceId: 'ws-1',
    kind: 'permission',
    tool: { name: 'bash', input: { token, command: `TOKEN='${token}' command` } },
  });

  assert.doesNotMatch(event.output, new RegExp(token));
  assert.match(event.output, /\[redacted\]/);
  assert.equal(ask.tool.input.token, '[redacted]');
  assert.doesNotMatch(ask.tool.input.command, new RegExp(token));
});

test('redacts every event in a history segment and preserves its cursor', () => {
  const history = redactAgentHistory({
    events: [{
      type: 'error',
      seq: 3,
      ts: 3,
      source: 'runtime',
      message: `request used Bearer ${token}`,
    }],
    prevCursor: 17,
  });

  assert.equal(history.prevCursor, 17);
  assert.doesNotMatch(history.events[0].message, new RegExp(token));
});

test('copies untrusted property names without mutating the object prototype', () => {
  const event = JSON.parse(`{
    "type":"tool_result",
    "seq":4,
    "ts":4,
    "source":"tool",
    "callId":"call-2",
    "ok":true,
    "output":"done",
    "__proto__":{"polluted":"yes"}
  }`);

  const redacted = redactAgentEvent(event);

  assert.equal(Object.getPrototypeOf(redacted), Object.prototype);
  assert.equal(Object.hasOwn(redacted, '__proto__'), true);
  assert.deepEqual(redacted.__proto__, { polluted: 'yes' });
  assert.equal({}.polluted, undefined);
});
