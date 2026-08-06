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
