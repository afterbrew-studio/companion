import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectSupervisor, planRestart } from '../dist/restart.js';

const RESTART_MODULE = new URL('../dist/restart.js', import.meta.url).href;

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'companion-restart-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A process that records itself and, on its first run only, restarts. The
 * recursion guard is the marker file: without it the unsupervised branch would
 * fork forever, which is also exactly what it must not do in production after
 * the successor comes up.
 */
function victim(dir) {
  const file = join(dir, 'victim.mjs');
  writeFileSync(
    file,
    `import { appendFileSync, readFileSync } from 'node:fs';\n` +
      `import { restartDaemon } from ${JSON.stringify(RESTART_MODULE)};\n` +
      `const marker = process.argv[2];\n` +
      `appendFileSync(marker, process.pid + '\\n');\n` +
      `const runs = readFileSync(marker, 'utf8').split('\\n').filter(Boolean).length;\n` +
      `if (runs === 1) restartDaemon(50);\n`,
  );
  return file;
}

const pids = (marker) => readFileSync(marker, 'utf8').split('\n').filter(Boolean);

async function waitForRuns(marker, n, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pids(marker).length >= n) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

test('a supervisor is recognised by the marks it leaves on the process', () => {
  assert.equal(detectSupervisor({ pm_id: '0' }, 4242), 'pm2');
  assert.equal(detectSupervisor({ INVOCATION_ID: 'abc' }, 4242), 'systemd');
  assert.equal(detectSupervisor({}, 1), 'container');
  assert.equal(detectSupervisor({}, 4242), null);
  // pid 1 inside a container is the normal case for both, and naming the
  // process manager is the more useful answer.
  assert.equal(detectSupervisor({ pm_id: '0' }, 1), 'pm2');
});

test('a supervised daemon exits and starts nothing, because exiting IS the restart', () => {
  for (const env of [{ pm_id: '0' }, { INVOCATION_ID: 'abc' }]) {
    const plan = planRestart({ pid: 4242, env, execPath: '/usr/bin/node', execArgv: [], argv: ['/a', 'b'] });
    assert.equal(plan.reexec, false);
    assert.deepEqual(plan.command, [], 'a child in a container dies with the container');
  }
});

test('an unsupervised daemon plans to re-exec itself, flags and all', () => {
  const plan = planRestart({
    pid: 4242,
    env: {},
    execPath: '/usr/bin/node',
    execArgv: ['--enable-source-maps'],
    // As node builds it: argv[0] is the executable, argv[1] the script.
    argv: ['/usr/bin/node', '/opt/companion/index.js', 'start', '--port', '7777'],
  });

  assert.equal(plan.supervisor, null);
  assert.equal(plan.reexec, true);
  // Dropping execArgv would restart a different process than the one running.
  assert.deepEqual(plan.command, [
    '/usr/bin/node',
    '--enable-source-maps',
    '/opt/companion/index.js',
    'start',
    '--port',
    '7777',
  ]);
});

test('an unsupervised daemon really does come back: it starts its successor and then exits', async (t) => {
  const dir = sandbox(t);
  const marker = join(dir, 'runs.txt');
  writeFileSync(marker, '');
  const env = { ...process.env };
  // Whatever is running the test suite must not decide which branch is taken.
  delete env.pm_id;
  delete env.INVOCATION_ID;

  // The successor inherits this pipe, so spawnSync returns once BOTH are gone.
  // The timeout turns "it forked forever" into a failure instead of a hang.
  const first = spawnSync(process.execPath, [victim(dir), marker], { env, encoding: 'utf8', timeout: 20_000 });
  assert.equal(first.status, 0, first.stderr);

  assert.equal(await waitForRuns(marker, 2), true, 'nothing replaced the process that stopped');
  const seen = pids(marker);
  assert.equal(seen.length, 2, 'exactly one successor, not a fork bomb');
  assert.notEqual(seen[0], seen[1], 'the successor is a new process, not a re-entry');
});

test('a supervised daemon leaves no successor behind for the supervisor to fight with', async (t) => {
  const dir = sandbox(t);
  const marker = join(dir, 'runs.txt');
  writeFileSync(marker, '');

  const first = spawnSync(process.execPath, [victim(dir), marker], {
    env: { ...process.env, pm_id: '0' },
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(first.status, 0, first.stderr);

  assert.equal(await waitForRuns(marker, 2, 1_500), false, 'pm2 restarts it; a self-spawned child would be a second daemon');
  assert.deepEqual(pids(marker).length, 1);
});
