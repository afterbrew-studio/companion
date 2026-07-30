import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runningPid, stopDaemon } from '../dist/daemon.js';

/** An unreachable address, so the "something is answering" check says no. */
const NOWHERE = 'http://127.0.0.1:9';

function home(t) {
  const dir = mkdtempSync(join(tmpdir(), 'companion-daemon-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function lock(dir, values) {
  writeFileSync(
    join(dir, 'instance.lock'),
    JSON.stringify({ pid: process.pid, host: hostname(), startedAt: 0, heartbeatAt: 0, ...values }),
  );
}

/** A process that does nothing but stay alive until it is signalled. */
function idleProcess(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  t.after(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone, which is what most of these tests are about.
    }
  });
  return child;
}

test('a daemon is only ours to see when its lock names a live pid on this host', (t) => {
  const dir = home(t);
  assert.equal(runningPid(dir), null);

  // A lock left by a machine sharing the volume says nothing about a process here.
  lock(dir, { host: 'some-other-box' });
  assert.equal(runningPid(dir), null);

  // A pid nobody is using is a crashed daemon, not a running one.
  lock(dir, { pid: 0x7fffffff });
  assert.equal(runningPid(dir), null);

  lock(dir, {});
  assert.equal(runningPid(dir), process.pid);
});

test('stop signals the process named in the lock and waits for it to go', async (t) => {
  const dir = home(t);
  const child = idleProcess(t);
  lock(dir, { pid: child.pid });

  const exited = new Promise((resolve) => child.once('exit', resolve));
  await stopDaemon(dir, NOWHERE);
  await exited;
  assert.equal(runningPid(dir), null);
});

test('stop is a no-op when nothing is running, and refuses a lock from another host', async (t) => {
  const dir = home(t);
  await stopDaemon(dir, NOWHERE);

  lock(dir, { pid: 0x7fffffff });
  await stopDaemon(dir, NOWHERE);

  lock(dir, { host: 'some-other-box' });
  await assert.rejects(() => stopDaemon(dir, NOWHERE), /runs on some-other-box/);
});
