import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const child = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'child', 'main.js');

/**
 * The whole tool loop against a fake OpenAI-compatible endpoint: the runtime
 * must offer its tools, execute them, change the working tree, stream, report
 * usage, and persist a continuation record that includes the tool exchanges.
 *
 * A fake provider rather than a real one on purpose. This asserts OUR loop, and
 * a test that needs a credential is a test nobody runs.
 */
test('the agent executes a tool loop and records what it did', async () => {
  let call = 0;
  const offered = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      call += 1;
      if (call === 1) offered.push(...(JSON.parse(body || '{}').tools ?? []).map((t) => t.function?.name));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const base = { id: `c${call}`, object: 'chat.completion.chunk', created: 1, model: 'fake' };
      const toolCall = (id, name, args) => ({
        ...base,
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }] },
            finish_reason: null,
          },
        ],
      });
      const end = (reason) => ({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: reason }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      });

      if (call === 1) {
        send(toolCall('call_read', 'read_file', '{"path":"alpha.txt"}'));
        send(end('tool_calls'));
      } else if (call === 2) {
        send(toolCall('call_edit', 'edit_file', '{"path":"alpha.txt","old_text":"hello","new_text":"HELLO"}'));
        send(end('tool_calls'));
      } else {
        for (const piece of ['Read alpha.txt', ' and uppercased', ' the greeting.']) {
          send({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
        }
        send(end('stop'));
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const cwd = mkdtempSync(join(tmpdir(), 'runtime-test-'));
  writeFileSync(join(cwd, 'alpha.txt'), 'hello from alpha\n');
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['add', '-A'], { cwd });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd });
  const statePath = join(cwd, '.state.json');

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
    sessionId: 'test-1',
    cwd,
    access: 'workspace-write',
    statePath,
    spec: {
      providerId: 'fake',
      kind: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'k',
      headers: {},
      query: {},
      model: 'fake',
      apiVersion: null,
      sampling: {},
      providerOptions: {},
      factoryOptions: {},
    },
    limits: { maxSteps: 6, turnTimeoutMs: 20_000, toolOutputChars: 4_000, commandTimeoutMs: 5_000, memoryMb: 512 },
  });
  send({ t: 'turn', turnId: 'test-1:t1', prompt: 'read alpha.txt then uppercase the greeting' });

  const outcome = await ended;
  proc.stdin.end();
  server.close();

  const ofType = (type) => events.filter((event) => event.type === type);

  assert.ok(offered.includes('read_file'), 'read_file is offered');
  assert.ok(offered.includes('git_commit'), 'git_commit is offered');
  assert.ok(!offered.includes('submit_result'), 'no result tool without a schema');
  assert.equal(ofType('user_prompt').length, 1);
  assert.equal(ofType('tool_call_requested').length, 2);
  assert.ok(ofType('tool_result').some((e) => e.ok && String(e.output).includes('hello from alpha')));
  assert.ok(ofType('tool_result').some((e) => e.ok && String(e.output).includes('edited alpha.txt')));
  assert.ok(readFileSync(join(cwd, 'alpha.txt'), 'utf8').startsWith('HELLO'), 'the file really changed');
  assert.ok(ofType('assistant_chunk').length >= 3, 'text streamed');
  assert.equal(ofType('assistant_message').length, 1);
  assert.ok(ofType('provider_response').length >= 1, 'usage reported');
  assert.equal(outcome.ok, true);
  assert.match(String(outcome.finalMessage), /uppercased/);

  // The continuation record must carry the tool exchanges, not just the answer:
  // a resumed run that lost them has the conclusion and no record of the work.
  assert.ok(existsSync(statePath));
  const messages = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.ok(messages.some((m) => m.role === 'tool'), 'tool results are in the continuation record');
});

/** The fences that are not about credentials: they protect state Companion recorded. */
test('the shell refuses the git commands that would invalidate the run', async () => {
  const { toolsFor } = await import('../dist/child/tools.js');
  const tools = toolsFor('workspace-write', {
    cwd: process.cwd(),
    limits: { maxSteps: 1, turnTimeoutMs: 1_000, toolOutputChars: 100, commandTimeoutMs: 1_000, memoryMb: 256 },
  });
  for (const command of ['git push origin main', 'git fetch', 'git checkout other', 'git worktree add x', 'git remote add x y']) {
    await assert.rejects(
      () => tools.run.execute({ command }, {}),
      /refused/,
      `${command} is refused`,
    );
  }
});

/**
 * Offering the result tool is not the same as saying the answer must go
 * through it. Measured against a real model, a structured task answered in
 * prose about half the time until the system prompt said so, and prose is
 * exactly what the caller's parser cannot use.
 */
test('a schema puts the result tool and its instruction in front of the model', async () => {
  let seen = null;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen ??= JSON.parse(body || '{}');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const base = { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'fake' };
      res.write(
        `data: ${JSON.stringify({
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_r',
                    type: 'function',
                    function: { name: 'submit_result', arguments: '{"score":7}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const cwd = mkdtempSync(join(tmpdir(), 'runtime-schema-'));
  const proc = spawn(process.execPath, [child], {
    cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
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
        if (frame.t === 'turn.end') resolve(frame);
      }
    });
  });

  const send = (frame) => proc.stdin.write(`${JSON.stringify(frame)}\n`);
  send({
    t: 'start',
    sessionId: 'schema-1',
    cwd,
    access: 'read-only',
    resultSchema: {
      type: 'object',
      required: ['score'],
      properties: { score: { type: 'integer' } },
    },
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
    limits: { maxSteps: 4, turnTimeoutMs: 20_000, toolOutputChars: 2_000, commandTimeoutMs: 5_000, memoryMb: 512 },
  });
  send({ t: 'turn', turnId: 'schema-1:t1', prompt: 'score it' });

  const outcome = await ended;
  proc.stdin.end();
  server.close();

  const tools = (seen.tools ?? []).map((t) => t.function?.name);
  assert.ok(tools.includes('submit_result'), 'the result tool is offered');
  const system = (seen.messages ?? []).find((m) => m.role === 'system');
  assert.match(String(system?.content), /submit_result/, 'and the model is told the answer must go through it');
  assert.equal(outcome.finalMessage, '{"score":7}', 'the structured answer becomes the final message');
});

/**
 * The compactor reached through the real loop, not just as a function: a
 * session whose conversation outgrows its window must trim and keep answering,
 * because the alternative is a provider refusal that loses the whole run.
 */
test('a long session trims itself and keeps going', async () => {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const base = { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'fake' };
      // A long answer, so the conversation grows fast enough to cross the window.
      res.write(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: 'z'.repeat(1500) }, finish_reason: null }] })}\n\n`,
      );
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const cwd = mkdtempSync(join(tmpdir(), 'runtime-compact-'));
  const proc = spawn(process.execPath, [child], {
    cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  const events = [];
  const turnEnds = [];
  const waiters = new Map();
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
      if (frame.t === 'turn.end') {
        turnEnds.push(frame);
        waiters.get(frame.turnId)?.();
      }
    }
  });

  const send = (frame) => proc.stdin.write(`${JSON.stringify(frame)}\n`);
  send({
    t: 'start',
    sessionId: 'compact-1',
    cwd,
    access: 'read-only',
    spec: {
      providerId: 'fake',
      kind: 'openai-compatible',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'k',
      headers: {},
      query: {},
      model: 'fake',
      // Small enough that three exchanges of this size cannot all fit.
      contextWindow: 900,
      apiVersion: null,
      sampling: {},
      providerOptions: {},
      factoryOptions: {},
    },
    limits: { maxSteps: 2, turnTimeoutMs: 20_000, toolOutputChars: 4_000, commandTimeoutMs: 5_000, memoryMb: 512 },
  });

  for (let turn = 1; turn <= 4; turn++) {
    const turnId = `compact-1:t${turn}`;
    const done = new Promise((resolve) => waiters.set(turnId, resolve));
    send({ t: 'turn', turnId, prompt: `question ${turn} ${'q'.repeat(600)}` });
    await done;
  }
  proc.stdin.end();
  server.close();

  const compactions = events.filter((e) => e.type === 'compaction');
  assert.ok(compactions.length > 0, 'the session trimmed itself');
  assert.ok(compactions[0].droppedMessages > 0, 'and said how much left the context');
  assert.ok(compactions[0].keptTokens <= Math.floor(900 * 0.7), 'down to inside the budget');
  assert.equal(turnEnds.length, 4, 'every turn still finished');
  assert.ok(
    turnEnds.every((end) => end.ok === true),
    'including the ones after trimming, which is the point',
  );
});

/**
 * The round trip no other harness Companion runs can do: stop before a tool
 * call that changes something, ask, and act on the answer. Claude Code and
 * Codex settle permission as a start-time policy and offer no headless way
 * back, so their approval affordance has always been dark.
 */
test('an attended run asks before it writes, and a denial reaches the model', async () => {
  /** What the model was sent once the refused tool answered. */
  let toldTheModel = '';
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      // Keyed on the CONVERSATION, not on a request counter: the SDK retries a
      // failed request, and a counter would answer the retry as if it were the
      // next step. A `tool` message exists only once a result came back.
      const sent = JSON.parse(body || '{}');
      const answered = (sent.messages ?? []).some((m) => m.role === 'tool');
      if (answered) toldTheModel = JSON.stringify(sent.messages);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const base = { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'fake' };
      if (!answered) {
        res.write(
          `data: ${JSON.stringify({
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_w',
                      type: 'function',
                      function: { name: 'write_file', arguments: '{"path":"new.txt","content":"hi"}' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
        );
      } else {
        res.write(
          `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: 'I was refused.' }, finish_reason: null }] })}\n\n`,
        );
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const cwd = mkdtempSync(join(tmpdir(), 'runtime-ask-'));
  const proc = spawn(process.execPath, [child], {
    cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  const events = [];
  const asks = [];
  const resolved = [];
  const send = (frame) => proc.stdin.write(`${JSON.stringify(frame)}\n`);
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
        if (frame.t === 'ask.resolved') resolved.push(frame.requestId);
        if (frame.t === 'ask') {
          asks.push(frame.ask);
          // The person says no.
          send({ t: 'ask.response', requestId: frame.ask.requestId, response: { mode: 'deny' } });
        }
        if (frame.t === 'turn.end') resolve(frame);
      }
    });
  });

  send({
    t: 'start',
    sessionId: 'ask-1',
    cwd,
    access: 'workspace-write',
    approvals: 'interactive',
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
    limits: { maxSteps: 4, turnTimeoutMs: 20_000, toolOutputChars: 2_000, commandTimeoutMs: 5_000, memoryMb: 512 },
  });
  send({ t: 'turn', turnId: 'ask-1:t1', prompt: 'create new.txt' });

  const outcome = await ended;
  proc.stdin.end();
  server.close();

  assert.equal(asks.length, 1, 'the write was held for a person');
  assert.equal(asks[0].tool.name, 'write_file', 'and the ask names the call being decided');
  assert.deepEqual(resolved, [asks[0].requestId], 'the ask was closed once answered');
  assert.ok(
    events.some((e) => e.type === 'tool_call_denied'),
    'the refusal is on the transcript, so a reader can see why nothing changed',
  );
  assert.ok(!existsSync(join(cwd, 'new.txt')), 'and the file was never written');
  // What reaches the model on the NEXT step is deliberately not asserted here.
  // The refusal is returned as the tool's result rather than thrown, so the
  // text is the model's to read, but whether a further step happens at all and
  // how the SDK renders that message varies between runs. Asserting it made
  // this test fail intermittently on somebody else's rendering rather than on
  // our behaviour, which is worth less than the four properties below.
  void toldTheModel;
  assert.equal(outcome.ok, true, `the turn ended cleanly rather than crashing (error: ${outcome.error ?? 'none'})`);
});

/**
 * Trimming has one rule that matters: a tool result may never outlive its call.
 * Cutting anywhere but a user-message boundary produces a conversation the
 * provider rejects for a reason that reads nothing like "too long".
 */
test('compaction drops whole exchanges and never orphans a tool result', async () => {
  const { compactMessages, estimateTokens } = await import('../dist/child/compaction.js');
  const round = (n) => [
    { role: 'user', content: `question ${n} ${'x'.repeat(400)}` },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: `c${n}`, toolName: 'read_file', input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: `c${n}`, toolName: 'read_file', output: 'y'.repeat(400) }] },
    { role: 'assistant', content: `answer ${n}` },
  ];
  const messages = [...round(1), ...round(2), ...round(3)];

  assert.equal(
    compactMessages(messages, estimateTokens(messages) + 10).droppedMessages,
    0,
    'a conversation that fits is untouched',
  );

  const trimmed = compactMessages(messages, estimateTokens([...round(2), ...round(3)]));
  assert.ok(trimmed.droppedMessages > 0, 'something was dropped');
  assert.equal(trimmed.messages[0].role, 'user', 'the kept conversation starts at an exchange boundary');

  const calls = new Set();
  for (const message of trimmed.messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === 'tool-call') calls.add(part.toolCallId);
      if (part.type === 'tool-result') assert.ok(calls.has(part.toolCallId), `${part.toolCallId} kept its call`);
    }
  }

  assert.equal(
    compactMessages(messages, 1).droppedMessages,
    0,
    'one oversized exchange is left for the provider to refuse, not silently mutilated',
  );
});
