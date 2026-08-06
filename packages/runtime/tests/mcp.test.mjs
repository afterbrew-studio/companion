import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const child = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'child', 'main.js');

/**
 * The MCP client against real servers on both transports.
 *
 * Real servers rather than a stubbed client: what this has to get right is the
 * wire — the handshake, the framing, the shape of a result — and a test that
 * mocks the transport asserts none of it.
 */

/** A server offering two tools, so an allowlist has something to exclude. */
const STDIO_SERVER = `
const tools = [
  { name: 'echo', description: 'Echo a value.', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } },
  { name: 'not_offered', description: 'Excluded by the allowlist.', inputSchema: { type: 'object', properties: {} } },
];
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const frame = JSON.parse(line);
    if (frame.id === undefined) continue;
    let result = {};
    if (frame.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } };
    else if (frame.method === 'tools/list') result = { tools };
    else if (frame.method === 'tools/call') result = { content: [{ type: 'text', text: 'echoed ' + frame.params.arguments.value }] };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }) + '\\n');
  }
});
`;

/** Start a child, run one turn, and collect what it emitted. */
function startChild({ cwd, port, mcpServers, prompt = 'use the tool' }) {
  const proc = spawn(process.execPath, [child], {
    cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const events = [];
  const ended = new Promise((resolve) => {
    let buffer = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const frame = JSON.parse(line);
        if (frame.t === 'event') events.push(frame.event);
        if (frame.t === 'turn.end') resolve(frame);
      }
    });
  });
  const send = (frame) => proc.stdin.write(`${JSON.stringify(frame)}\n`);
  send({
    t: 'start',
    sessionId: 'mcp-1',
    cwd,
    access: 'workspace-write',
    spec: {
      providerId: 'fake',
      kind: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'k',
      headers: {},
      query: {},
      model: 'fake',
      contextWindow: null,
      apiVersion: null,
      sampling: {},
      providerOptions: {},
      factoryOptions: {},
    },
    limits: {
      maxSteps: 6,
      turnTimeoutMs: 20_000,
      toolOutputChars: 4_000,
      commandTimeoutMs: 5_000,
      memoryMb: 512,
      approvalTimeoutMs: 5_000,
    },
    mcpServers,
  });
  send({ t: 'turn', turnId: 'mcp-1:t1', prompt });
  return { proc, ended, events };
}

/** The common case: run the turn, close stdin, hand back what happened. */
async function runTurn(options) {
  const { proc, ended, events } = startChild(options);
  const outcome = await ended;
  proc.stdin.end();
  return { outcome, events };
}

/** A provider that calls one named tool, then answers. */
function fakeProvider(toolName, args) {
  const offered = [];
  let call = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      call += 1;
      if (call === 1) offered.push(...(JSON.parse(body || '{}').tools ?? []).map((t) => t.function?.name));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const base = { id: `c${call}`, object: 'chat.completion.chunk', created: 1, model: 'fake' };
      if (call === 1 && toolName) {
        send({
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: toolName, arguments: args } }],
              },
              finish_reason: null,
            },
          ],
        });
        send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        send({ ...base, choices: [{ index: 0, delta: { content: 'done.' }, finish_reason: null }] });
        send({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        });
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return { server, offered };
}

test('a stdio MCP server contributes namespaced tools, narrowed by the allowlist', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mcp-stdio-'));
  const serverPath = join(cwd, 'server.mjs');
  writeFileSync(serverPath, STDIO_SERVER);

  const { server, offered } = fakeProvider('mcp__demo__echo', '{"value":"hi"}');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  const { outcome, events } = await runTurn({
    cwd,
    port: server.address().port,
    mcpServers: [
      {
        id: 'demo',
        label: 'Demo',
        transport: { kind: 'stdio', command: process.execPath, args: [serverPath], env: {} },
        tools: ['echo'],
      },
    ],
  });
  server.close();

  assert.ok(offered.includes('mcp__demo__echo'), 'the MCP tool is offered under its namespace');
  assert.ok(!offered.includes('echo'), 'never under its bare name, which could collide with a built-in');
  assert.ok(!offered.includes('mcp__demo__not_offered'), 'the allowlist excludes the rest');
  const results = events.filter((event) => event.type === 'tool_result');
  assert.ok(
    results.some((event) => event.ok && String(event.output).includes('echoed hi')),
    'the call reached the server and its answer reached the transcript',
  );
  assert.equal(outcome.ok, true);
});

test('an HTTP MCP server works over both a JSON and an event-stream reply', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mcp-http-'));
  const seen = [];
  let initialized = false;
  const mcp = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const frame = JSON.parse(body || '{}');
      seen.push({ method: frame.method, auth: req.headers.authorization, protocol: req.headers['mcp-protocol-version'] });
      if (frame.id === undefined) {
        // Deliberately slow, and strict below: on HTTP every frame is its own
        // POST, so a client that does not wait for this one has its tools/list
        // refused. Companion's own MCP server answers exactly this way.
        setTimeout(() => {
          initialized = true;
          res.writeHead(202).end();
        }, 50);
        return;
      }
      if (frame.method !== 'initialize' && !initialized) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ jsonrpc: '2.0', id: frame.id, error: { code: -32002, message: 'Server not initialized' } }),
        );
        return;
      }
      if (frame.method === 'tools/call') {
        // The other half of the transport: the answer arrives as one SSE frame
        // on a stream the server is entitled to keep open afterwards.
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({
            jsonrpc: '2.0',
            id: frame.id,
            result: { content: [{ type: 'text', text: 'remote says ok' }] },
          })}\n\n`,
        );
        return; // deliberately left open
      }
      const result =
        frame.method === 'initialize'
          ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'remote', version: '1' } }
          : { tools: [{ name: 'ping', description: 'Ping.', inputSchema: { type: 'object', properties: {} } }] };
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's1' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result }));
    });
  });
  await new Promise((r) => mcp.listen(0, '127.0.0.1', r));

  const { server, offered } = fakeProvider('mcp__remote__ping', '{}');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  const { outcome, events } = await runTurn({
    cwd,
    port: server.address().port,
    mcpServers: [
      {
        id: 'remote',
        label: 'Remote',
        transport: {
          kind: 'http',
          url: `http://127.0.0.1:${mcp.address().port}/mcp`,
          headers: { authorization: 'Bearer supplied-by-the-daemon' },
        },
        tools: null,
      },
    ],
  });
  server.close();
  mcp.close();

  assert.ok(offered.includes('mcp__remote__ping'));
  assert.ok(
    events.some((event) => event.type === 'tool_result' && event.ok && String(event.output).includes('remote says ok')),
    'an answer delivered over SSE is read without waiting for the stream to end',
  );
  assert.deepEqual(
    seen.map((entry) => entry.method),
    ['initialize', 'notifications/initialized', 'tools/list', 'tools/call'],
    'the handshake happens in order and the notification is sent',
  );
  assert.ok(
    seen.every((entry) => entry.auth === 'Bearer supplied-by-the-daemon'),
    'the configured credential is on every request, including the notification',
  );
  assert.ok(
    seen.slice(1).every((entry) => entry.protocol === '2025-06-18'),
    'the negotiated protocol version is echoed after initialize',
  );
  assert.equal(outcome.ok, true);
});

/**
 * The failure mode that matters most: an integration being down is not a
 * reason for the work to fail. It costs its own tools, says so on the
 * transcript, and the turn runs on what is left.
 */
test('a server that will not connect costs its tools and not the run', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mcp-dead-'));
  const { server, offered } = fakeProvider(null, null);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  const { outcome, events } = await runTurn({
    cwd,
    port: server.address().port,
    mcpServers: [
      {
        id: 'dead',
        label: 'Dead',
        transport: { kind: 'stdio', command: join(cwd, 'no-such-binary'), args: [], env: {} },
        tools: null,
      },
    ],
  });
  server.close();

  assert.equal(outcome.ok, true, 'the turn still completes');
  assert.ok(offered.includes('read_file'), 'the built-in tools are still offered');
  assert.ok(!offered.some((name) => name.startsWith('mcp__')), 'a server that never connected contributes nothing');
  const problem = events.find((event) => event.type === 'error' && event.kind === 'mcp');
  assert.ok(problem, 'the transcript says which server was unavailable');
  assert.match(String(problem.message), /Dead/);
});

/**
 * A terminated run must let go of the servers it started.
 *
 * Two things are pinned here. The child exits on SIGTERM under its own power
 * rather than waiting out the parent's follow-up SIGKILL — registering a signal
 * handler replaces default termination, and an open stdin would otherwise hold
 * it. And the MCP server it spawned goes with it, instead of outliving the run
 * that asked for it.
 */
test('a terminated session stops, and takes its MCP server with it', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'mcp-term-'));
  const serverPath = join(cwd, 'server.mjs');
  const pidPath = join(cwd, 'server.pid');
  writeFileSync(serverPath, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(pidPath)}, String(process.pid));\n${STDIO_SERVER}`);

  const { server } = fakeProvider(null, null);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { proc, ended } = startChild({
    cwd,
    port: server.address().port,
    mcpServers: [
      {
        id: 'demo',
        label: 'Demo',
        transport: { kind: 'stdio', command: process.execPath, args: [serverPath], env: {} },
        tools: null,
      },
    ],
  });
  await ended;
  server.close();

  const serverPid = Number(readFileSync(pidPath, 'utf8'));
  const exited = new Promise((resolve) => proc.once('exit', (code, signal) => resolve({ code, signal })));
  proc.kill('SIGTERM');
  const outcome = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timed out'), 3_000))]);

  assert.notEqual(outcome, 'timed out', 'the child exits on SIGTERM without needing to be killed');
  assert.equal(outcome.signal, null, 'and exits under its own power rather than on a signal');

  // The server was asked to stop; give it the moment that takes before asking.
  await new Promise((r) => setTimeout(r, 500));
  assert.throws(() => process.kill(serverPid, 0), /ESRCH/, 'the MCP server did not outlive the run');
});

/**
 * An external tool is behind the approval guard at every access, including
 * read-only: "read-only" describes this checkout, and an MCP server reaches
 * something else entirely.
 */
test('MCP tools are guarded at every access, and the guard wraps exactly once', async () => {
  const { toolsFor } = await import('../dist/child/tools.js');
  const limits = {
    maxSteps: 1,
    turnTimeoutMs: 1_000,
    toolOutputChars: 100,
    commandTimeoutMs: 1_000,
    memoryMb: 256,
    approvalTimeoutMs: 1_000,
  };
  const { McpHub } = await import('../dist/child/mcp.js');
  const hub = new McpHub([], limits, () => {});

  for (const access of ['read-only', 'workspace-write', 'trusted-assistant']) {
    let asked = 0;
    let ran = 0;
    const mcpTools = {
      mcp__x__do: {
        description: 'x',
        inputSchema: { jsonSchema: { type: 'object' } },
        execute: async () => {
          ran += 1;
          return 'ran';
        },
      },
    };
    const tools = toolsFor(access, {
      cwd: process.cwd(),
      limits,
      mcpTools,
      approve: async () => {
        asked += 1;
        return { allowed: false };
      },
    });
    const answer = await tools.mcp__x__do.execute({}, {});
    assert.equal(asked, 1, `${access}: asked exactly once`);
    assert.equal(ran, 0, `${access}: a denied call does not run`);
    assert.match(String(answer), /refused/, `${access}: the model is told why`);
  }

  // The hub builds fresh tool objects each turn; a shared object would collect
  // one approval wrapper per turn and ask the same question twice, then thrice.
  assert.notEqual(hub.toolSet(), hub.toolSet());
});
