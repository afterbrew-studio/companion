import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const agent = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const TOKEN = 'fix-run-token';

async function freePort() {
  const probe = createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const { port } = probe.address();
  await new Promise((r) => probe.close(r));
  return port;
}

const git = (args, cwd) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' });

/**
 * A fix run's real mechanics on a remote runner, end to end.
 *
 * Not the protocol: the WORK. The daemon's part of a fix run is prepare a
 * worktree, start the run's runtime there, prompt it, read the diff back, and
 * commit it under Companion's own authorship. Every one of those except the
 * prompt is a `/agent/git/*` endpoint that predates this runtime and is shared
 * with moxxy, so this is also the check that the built-in runtime is a peer of
 * the runtimes already attached rather than a parallel path.
 *
 * The push is deliberately absent: it needs a GitHub credential the daemon
 * mints per operation, and it is the daemon's call, not the runner's.
 */
test('a remote runner performs a fix run: prepared worktree, agent change, diff, commit', async (t) => {
  // The model is scripted so the ASSERTIONS are about Companion's mechanics
  // rather than about whether a model felt like editing the right file.
  let round = 0;
  const provider = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const first = round++ === 0;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const base = { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'fake' };
      if (first) {
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
                      id: 'call_fix',
                      type: 'function',
                      function: {
                        name: 'edit_file',
                        arguments: JSON.stringify({
                          path: 'src/paging.ts',
                          old_text: 'cursor >= last',
                          new_text: 'cursor > last',
                        }),
                      },
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
          `data: ${JSON.stringify({
            ...base,
            choices: [{ index: 0, delta: { content: 'Fixed the off-by-one in the pagination cursor.' }, finish_reason: null }],
          })}\n\n`,
        );
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((r) => provider.listen(0, '127.0.0.1', r));
  const providerPort = provider.address().port;

  // The repository the run works on. A bare origin plus a seeded main, which is
  // the shape `Checkouts` clones from on a real machine.
  const origin = mkdtempSync(join(tmpdir(), 'fix-origin-'));
  git(['init', '--bare', '-q', '-b', 'main', '.'], origin);
  const seed = mkdtempSync(join(tmpdir(), 'fix-seed-'));
  git(['init', '-q', '-b', 'main', '.'], seed);
  execFileSync('mkdir', ['-p', join(seed, 'src')]);
  execFileSync('sh', ['-c', `printf 'export const nextPage = (cursor, last) => cursor >= last;\\n' > ${join(seed, 'src/paging.ts')}`]);
  git(['add', '-A'], seed);
  git(['commit', '-qm', 'seed'], seed);
  git(['remote', 'add', 'origin', origin], seed);
  git(['push', '-q', 'origin', 'main'], seed);

  const home = mkdtempSync(join(tmpdir(), 'fix-runner-'));
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
  t.after(() => {
    runner.kill('SIGKILL');
    provider.close();
  });

  const call = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}/agent${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text}`);
    return text ? JSON.parse(text) : {};
  };

  let up = null;
  for (let attempt = 0; attempt < 60 && up === null; attempt++) {
    await new Promise((r) => setTimeout(r, 250));
    up = await call('GET', '/health').catch(() => null);
  }
  assert.ok(up, 'the runner came up');

  const runId = 'fix-run-1';

  // 1. The daemon prepares a working directory on the machine. This checkout
  //    stands in for `/agent/git/worktree`, whose only extra work is fetching
  //    origin with the hub's GitHub credential, and it is placed under the
  //    runner's MANAGED worktree root because that is what the machine will
  //    later accept a verification command in. A path anywhere else is refused,
  //    which is asserted below.
  const cwd = join(home, 'worktrees', 'fix-paging');
  git(['clone', '-q', origin, cwd], tmpdir());
  git(['checkout', '-q', '-b', 'fix/paging'], cwd);

  // 2. The run starts under the runtime its row records, on that worktree.
  await call('POST', `/runs/${runId}/spawn`, {
    cwd,
    sessionId: runId,
    access: 'workspace-write',
    harness: 'companion',
    model: null,
  });

  // 3. The agent is prompted and changes the tree.
  await call('POST', `/runs/${runId}/prompt`, { prompt: 'Fix the off-by-one in the pagination cursor.' });
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise((r) => setTimeout(r, 250));
    if (readFileSync(join(cwd, 'src/paging.ts'), 'utf8').includes('cursor > last')) break;
  }
  assert.match(
    readFileSync(join(cwd, 'src/paging.ts'), 'utf8'),
    /cursor > last/,
    'the agent changed the checked-out file, on the runner',
  );

  // 4. The daemon reads the diff back through the runner's own git endpoint,
  //    which is the same one every other runtime's run goes through.
  const { diff } = await call('POST', '/git/diff', { cwd, baseBranch: 'main' });
  assert.match(diff, /-export const nextPage.*cursor >= last/s, 'the diff shows what was there');
  assert.match(diff, /\+export const nextPage.*cursor > last/s, 'and what the agent replaced it with');

  // 5. Companion commits it under its OWN authorship, collapsing onto the base
  //    exactly as a fresh PR does. This is the step that makes the result
  //    reviewable rather than whatever the model left behind.
  await call('POST', '/git/commit-all', {
    cwd,
    message: 'Fix off-by-one in pagination cursor',
    author: { name: 'Companion', email: 'companion@example.com' },
    baseBranch: 'main',
  });
  const log = git(['log', '-1', '--pretty=%an <%ae>%n%s'], cwd);
  assert.match(log, /Companion <companion@example\.com>/, 'the commit is attributed to Companion');
  assert.match(log, /Fix off-by-one in pagination cursor/, 'with the message Companion chose');
  assert.equal(git(['status', '--porcelain'], cwd).trim(), '', 'and nothing is left uncommitted');

  // 6. The repository's own verification command runs in that worktree, which
  //    is what puts "this diff builds" above the diff a person reads.
  const passed = await call('POST', '/verify', { cwd, command: 'grep -q "cursor > last" src/paging.ts' });
  assert.equal(passed.exitCode, 0, 'verification runs in the run\'s worktree');
  const failed = await call('POST', '/verify', { cwd, command: 'exit 3' });
  assert.equal(failed.exitCode, 3, 'and a failure is reported as one rather than swallowed');
  // The fence that keeps "verify" from meaning "run this on my machine".
  const { cwd: scratch } = await call('POST', '/scratch', { runId: `${runId}-scratch` });
  await assert.rejects(
    () => call('POST', '/verify', { cwd: scratch, command: 'true' }),
    /not a managed worktree/,
    'a directory outside the managed root is refused',
  );

  // 7. The reviewed branch is published. This is the last step of a fix run and
  //    the only one that reaches a remote: `Checkouts.push` sends `HEAD` to
  //    `origin`, carrying whatever credential the daemon resolved for it. The
  //    origin here is local, so what is proven is the mechanics rather than
  //    GitHub's acceptance of a token.
  // Without a credential the machine REFUSES rather than trying: the fence is
  // fail-closed, and this is the message an operator would see.
  await assert.rejects(
    () => call('POST', '/git/push', { repo: 'acme/app', cwd, branch: 'fix/paging' }),
    /no GitHub credential/,
    'a push with no credential is refused, not attempted',
  );
  await call('POST', '/git/push', { repo: 'acme/app', cwd, branch: 'fix/paging', githubToken: 'test-token' });
  const published = git(['log', '-1', '--pretty=%s', 'fix/paging'], origin);
  assert.match(published, /Fix off-by-one in pagination cursor/, 'the branch reached the origin');

  // 8. The run is released, as the orchestrator does when it enters review.
  await call('POST', `/runs/${runId}/stop`);
  const health = await call('GET', '/health');
  assert.equal(health.liveRuns, 0, 'the slot is free again');
});
