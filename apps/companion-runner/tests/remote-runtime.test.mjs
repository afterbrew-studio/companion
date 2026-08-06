import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const agent = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const TOKEN = 'test-runner-token';

/** A port the OS just told us is free, rather than one derived and hoped for. */
async function freePort() {
  const probe = createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
}

/**
 * The whole remote path, with no daemon: the published agent, started as an
 * operator would start it, driven over the same HTTP + WS surface companiond
 * uses. It proves the thing protocol 7 exists for, which is that a machine
 * somewhere else can run Companion's own runtime and stream its work back.
 *
 * The model is this machine's own (`COMPANION_RUNNER_PROVIDER_*`), pointed at a
 * fake OpenAI-compatible endpoint. That is also the configuration a runner
 * reached over plain http MUST have, so the test covers the supported shape
 * rather than the one that needs TLS.
 */
test('a remote runner executes a run under the built-in runtime', async (t) => {
  let turn = 0;
  const provider = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      turn += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const base = { id: `c${turn}`, object: 'chat.completion.chunk', created: 1, model: 'fake' };
      if (turn === 1) {
        send({
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [
                  { index: 0, id: 'call_1', type: 'function', function: { name: 'list_files', arguments: '{}' } },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
      } else {
        send({ ...base, choices: [{ index: 0, delta: { content: 'Looked around.' }, finish_reason: null }] });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } });
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((r) => provider.listen(0, '127.0.0.1', r));
  const providerPort = provider.address().port;

  const home = mkdtempSync(join(tmpdir(), 'runner-test-'));
  const port = await freePort();
  const runner = spawn(process.execPath, [agent], {
    env: {
      ...process.env,
      COMPANION_RUNNER_HOME: home,
      COMPANION_RUNNER_TOKEN: TOKEN,
      COMPANION_RUNNER_HOST: '127.0.0.1',
      COMPANION_RUNNER_PORT: String(port),
      COMPANION_RUNNER_PROVIDER_KIND: 'openai-compatible',
      COMPANION_RUNNER_PROVIDER_URL: `http://127.0.0.1:${providerPort}/v1`,
      COMPANION_RUNNER_PROVIDER_KEY: 'k',
      COMPANION_RUNNER_MODEL: 'fake',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    runner.kill('SIGKILL');
    provider.close();
  });

  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, body) => {
    const res = await fetch(`${base}/agent${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text}`);
    return text ? JSON.parse(text) : {};
  };

  // Wait for the agent to bind, the same way companiond's probe would.
  let health = null;
  for (let attempt = 0; attempt < 60 && health === null; attempt++) {
    await new Promise((r) => setTimeout(r, 250));
    health = await call('GET', '/health').catch(() => null);
  }
  assert.ok(health, 'the runner came up');
  assert.equal(health.protocol, 7);
  const runtime = health.runtimes.find((r) => r.id === 'companion');
  assert.ok(runtime, 'the built-in runtime is advertised');
  assert.equal(runtime.state, 'ready', 'a machine with its own model is ready');

  const events = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/agent/events?token=${TOKEN}`);
  const streamed = new Promise((resolve) => {
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.t === 'event') events.push(msg.event);
      if (msg.t === 'turn.complete') resolve(msg);
    });
  });
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });

  const runId = 'remote-test-1';
  const { cwd } = await call('POST', '/scratch', { runId });
  await call('POST', `/runs/${runId}/spawn`, {
    cwd,
    sessionId: runId,
    access: 'workspace-write',
    harness: 'companion',
    model: null,
  });
  await call('POST', `/runs/${runId}/prompt`, { prompt: 'look around' });
  await streamed;

  assert.ok(
    events.some((e) => e.type === 'tool_call_requested' && e.name === 'list_files'),
    'the tool call streamed back over the websocket',
  );
  assert.ok(events.some((e) => e.type === 'assistant_message'), 'the answer streamed back');
  assert.ok(events.some((e) => e.type === 'provider_response'), 'usage streamed back');

  const history = await call('GET', `/runs/${runId}/history?limit=100`);
  assert.ok(history.events.length > 0, 'the run has a transcript the daemon can page');

  await call('POST', `/runs/${runId}/stop`);
  ws.close();
});

/** The refusal that keeps a machine from accepting work it cannot finish. */
test('a runner with no model refuses the run and says why', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'runner-test-'));
  const port = await freePort();
  const runner = spawn(process.execPath, [agent], {
    env: {
      ...process.env,
      COMPANION_RUNNER_HOME: home,
      COMPANION_RUNNER_TOKEN: TOKEN,
      COMPANION_RUNNER_HOST: '127.0.0.1',
      COMPANION_RUNNER_PORT: String(port),
      COMPANION_RUNNER_PROVIDER_KIND: '',
      COMPANION_RUNNER_MODEL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => runner.kill('SIGKILL'));

  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, body) => {
    const res = await fetch(`${base}/agent${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, text: await res.text() };
  };

  // The agent is still binding for the first few attempts, so a refused
  // connection is "not yet", not a failure.
  let health = null;
  for (let attempt = 0; attempt < 60 && health === null; attempt++) {
    await new Promise((r) => setTimeout(r, 250));
    const res = await call('GET', '/health').catch(() => null);
    health = res?.status === 200 ? JSON.parse(res.text) : null;
  }
  assert.ok(health, 'the runner came up');
  const runtime = health.runtimes.find((r) => r.id === 'companion');
  assert.equal(runtime.state, 'unavailable', 'a machine with no model does not claim to be ready');
  assert.equal(runtime.needsModel, true, 'and says which gap it is, so the daemon can fill it');

  const { cwd } = JSON.parse((await call('POST', '/scratch', { runId: 'no-model' })).text);
  const spawned = await call('POST', '/runs/no-model/spawn', {
    cwd,
    sessionId: 'no-model',
    access: 'workspace-write',
    harness: 'companion',
  });
  assert.equal(spawned.status, 503);
  assert.match(spawned.text, /no model configured/);
});
