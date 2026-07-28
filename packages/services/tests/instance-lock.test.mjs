import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { InstanceLock } from '../dist/instance-lock.js';

/**
 * Companion is a single-node appliance: the data directory holds clones,
 * worktrees and the moxxy home, so two daemons sharing it duplicate every
 * scheduled job and contend on the same checkouts. These pin the two halves of
 * making that loud: refuse a live holder, and never block a legitimate restart.
 */

async function withHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'companion-lock-'));
  const prev = process.env.COMPANION_HOME;
  process.env.COMPANION_HOME = home;
  try {
    return await fn(join(home, 'instance.lock'));
  } finally {
    rmSync(home, { recursive: true, force: true });
    if (prev === undefined) delete process.env.COMPANION_HOME;
    else process.env.COMPANION_HOME = prev;
  }
}

test('acquiring writes a lock naming this process, and releasing removes it', async () => {
  await withHome(async (file) => {
    const lock = new InstanceLock();
    await lock.acquire();
    const held = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(held.pid, process.pid);
    assert.equal(held.host, hostname());
    lock.release();
    assert.equal(existsSync(file), false);
  });
});

test('a second daemon on the same home refuses, naming the holder', async () => {
  await withHome(async (file) => {
    // A live process on this host that is not us: the test runner's parent is
    // guaranteed to exist and is not this pid.
    writeFileSync(
      file,
      JSON.stringify({ pid: process.ppid, host: hostname(), startedAt: Date.now(), heartbeatAt: Date.now() }),
    );
    await assert.rejects(() => new InstanceLock(0).acquire(), (err) => {
      assert.match(err.message, /another Companion daemon is already using/);
      assert.match(err.message, new RegExp(String(process.ppid)));
      assert.match(err.message, /single-node/);
      return true;
    });
  });
});

test('a dead process on this host is taken over immediately, not after a timeout', async () => {
  await withHome(async (file) => {
    // A fresh heartbeat, so only the liveness check can decide. Waiting out the
    // heartbeat here would stall every supervisor restart after a SIGKILL.
    writeFileSync(
      file,
      JSON.stringify({ pid: 2 ** 22, host: hostname(), startedAt: Date.now(), heartbeatAt: Date.now() }),
    );
    const lock = new InstanceLock();
    await lock.acquire();
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, process.pid);
    lock.release();
  });
});

test('another host is judged by heartbeat only, since its pid means nothing here', async () => {
  await withHome(async (file) => {
    const foreign = { pid: process.pid, host: `${hostname()}-elsewhere`, startedAt: Date.now() };
    // Fresh beat: refuse, even though that pid is alive locally (it is ours).
    writeFileSync(file, JSON.stringify({ ...foreign, heartbeatAt: Date.now() }));
    await assert.rejects(() => new InstanceLock(0).acquire(), /already using/);

    // Stale beat: take over.
    writeFileSync(file, JSON.stringify({ ...foreign, heartbeatAt: Date.now() - 120_000 }));
    const lock = new InstanceLock();
    await lock.acquire();
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).host, hostname());
    lock.release();
  });
});

test('releasing does not delete a lock another daemon has since taken', async () => {
  await withHome(async (file) => {
    const lock = new InstanceLock();
    await lock.acquire();
    const winner = { pid: process.ppid, host: hostname(), startedAt: Date.now(), heartbeatAt: Date.now() };
    writeFileSync(file, JSON.stringify(winner));
    lock.release();
    assert.equal(existsSync(file), true, 'a takeover race must not have its lock removed by the loser');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, process.ppid);
  });
});

test('an unreadable lock is treated as absent rather than fatal', async () => {
  await withHome(async (file) => {
    writeFileSync(file, 'not json');
    const lock = new InstanceLock();
    await lock.acquire();
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, process.pid);
    lock.release();
  });
});

test('a redeploy waits out the predecessor instead of failing the boot', async () => {
  await withHome(async (file) => {
    // Exactly the container case: a different host (the old container id), a
    // fresh heartbeat, and pid 1, which is what every containerised daemon is.
    // Refusing here failed the deployment; the beat simply has to age out.
    writeFileSync(
      file,
      JSON.stringify({ pid: 1, host: 'old-container', startedAt: Date.now(), heartbeatAt: Date.now() }),
    );
    const lock = new InstanceLock(3_000);
    const boot = lock.acquire();

    // The predecessor is gone, so nothing refreshes the beat. Age it out.
    setTimeout(() => {
      writeFileSync(
        file,
        JSON.stringify({ pid: 1, host: 'old-container', startedAt: 1, heartbeatAt: Date.now() - 120_000 }),
      );
    }, 200);

    await boot;
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, process.pid);
    lock.release();
  });
});

test('a predecessor that keeps beating is still refused', async () => {
  await withHome(async (file) => {
    const write = () =>
      writeFileSync(
        file,
        JSON.stringify({ pid: 1, host: 'live-container', startedAt: 1, heartbeatAt: Date.now() }),
      );
    // Beat once before acquiring, or the first read finds no lock at all and
    // the test proves nothing.
    write();
    const beat = setInterval(write, 100);
    try {
      // The invariant the lock exists for: two live daemons never share a home.
      await assert.rejects(() => new InstanceLock(1_500).acquire(), /kept heartbeating for/);
    } finally {
      clearInterval(beat);
    }
  });
});

/**
 * Handover. Two containers cannot see each other's processes, so a rolling
 * deploy deadlocks: the replacement will not be healthy until it holds the
 * home, and the orchestrator will not stop the original until the replacement
 * is healthy. The data directory is the one channel they share.
 */

const handoverFile = (file) => file.replace(/instance\.lock$/, 'instance.handover');
const liveHolder = (host) => ({ pid: process.ppid, host, startedAt: Date.now(), heartbeatAt: Date.now() });

test('a waiting daemon asks the live holder to stand down', async () => {
  await withHome(async (file) => {
    writeFileSync(file, JSON.stringify(liveHolder('old-container')));

    await assert.rejects(() => new InstanceLock(0).acquire(), /already using/);

    const note = JSON.parse(readFileSync(handoverFile(file), 'utf8'));
    assert.equal(note.requestedBy, hostname());
    assert.equal(note.yieldedBy, null);
  });
});

test('the holder stands down when the note names someone else', async () => {
  await withHome(async (file) => {
    const lock = new InstanceLock();
    await lock.acquire();
    let stood = 0;
    lock.handoverTo(() => (stood += 1));
    writeFileSync(
      handoverFile(file),
      JSON.stringify({ requestedBy: 'new-container', requestedAt: Date.now(), yieldedBy: null, yieldedAt: 0 }),
    );

    lock.beat();

    assert.equal(stood, 1);
    assert.equal(JSON.parse(readFileSync(handoverFile(file), 'utf8')).yieldedBy, hostname());
    // Once is enough: a second beat before the process is gone must not re-enter
    // a shutdown that is already running.
    lock.beat();
    assert.equal(stood, 1);
    lock.release();
  });
});

test('a daemon never stands down for its own request', async () => {
  await withHome(async (file) => {
    const lock = new InstanceLock();
    await lock.acquire();
    let stood = 0;
    lock.handoverTo(() => (stood += 1));
    writeFileSync(
      handoverFile(file),
      JSON.stringify({ requestedBy: hostname(), requestedAt: Date.now(), yieldedBy: null, yieldedAt: 0 }),
    );

    lock.beat();

    assert.equal(stood, 0, 'asking yourself to leave would end every single-daemon boot');
    lock.release();
  });
});

test('a stale request is a leftover, not an ask', async () => {
  await withHome(async (file) => {
    const lock = new InstanceLock();
    await lock.acquire();
    let stood = 0;
    lock.handoverTo(() => (stood += 1));
    writeFileSync(
      handoverFile(file),
      JSON.stringify({
        requestedBy: 'long-gone',
        requestedAt: Date.now() - 10 * 60_000,
        yieldedBy: null,
        yieldedAt: 0,
      }),
    );

    lock.beat();

    assert.equal(stood, 0);
    lock.release();
  });
});

test('the container that stood down refuses to evict its own replacement', async () => {
  await withHome(async (file) => {
    // What `restart: unless-stopped` does to the container that just yielded.
    writeFileSync(file, JSON.stringify(liveHolder('new-container')));
    writeFileSync(
      handoverFile(file),
      JSON.stringify({
        requestedBy: 'new-container',
        requestedAt: Date.now(),
        yieldedBy: hostname(),
        yieldedAt: Date.now(),
      }),
    );

    await assert.rejects(() => new InstanceLock(0).acquire(), /superseded/);
    // And it must not have asked, which is the ping-pong.
    assert.equal(JSON.parse(readFileSync(handoverFile(file), 'utf8')).requestedBy, 'new-container');
  });
});

test('a second handover is refused during the cooldown', async () => {
  await withHome(async (file) => {
    writeFileSync(file, JSON.stringify(liveHolder('other-container')));
    writeFileSync(
      handoverFile(file),
      JSON.stringify({
        requestedBy: 'other-container',
        requestedAt: Date.now(),
        yieldedBy: 'someone-else',
        yieldedAt: Date.now(),
      }),
    );

    await assert.rejects(() => new InstanceLock(0).acquire(), /already using/);

    // Two daemons that both want the home would otherwise evict each other
    // forever; the cooldown makes the loser fail with the ordinary error.
    assert.equal(JSON.parse(readFileSync(handoverFile(file), 'utf8')).requestedBy, 'other-container');
  });
});

test('COMPANION_LOCK_HANDOVER=off keeps the old refusal exactly', async () => {
  await withHome(async (file) => {
    writeFileSync(file, JSON.stringify(liveHolder('old-container')));
    process.env.COMPANION_LOCK_HANDOVER = 'off';
    try {
      await assert.rejects(() => new InstanceLock(0).acquire(), /already using/);
      assert.equal(existsSync(handoverFile(file)), false);
    } finally {
      delete process.env.COMPANION_LOCK_HANDOVER;
    }
  });
});
