import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { Checkouts, cleanupRunnerStorage } from '../dist/exec/index.js';

const exists = async (path) => access(path).then(() => true, () => false);
const execFileP = promisify(execFile);

test('storage cleanup removes only expired artifacts and protects leased or live runs', async () => {
  const home = await mkdtemp(join(tmpdir(), 'companion-storage-cleanup-'));
  const previousHome = process.env.COMPANION_HOME;
  process.env.COMPANION_HOME = home;
  try {
    const roots = {
      worktrees: join(home, 'worktrees'),
      scratch: join(home, 'scratch'),
      sessions: join(home, 'moxxy-home', 'sessions'),
      configs: join(home, 'run-configs'),
    };
    await Promise.all(Object.values(roots).map((root) => mkdir(root, { recursive: true })));

    const old = new Date(Date.now() - 2 * 60 * 60_000);
    const worktree = async (runId, stale) => {
      const cwd = join(roots.worktrees, runId);
      await mkdir(cwd);
      await writeFile(
        join(cwd, '.git'),
        `gitdir: ${join(home, 'repos', 'acme', runId, '.git', 'worktrees', runId)}\n`,
      );
      if (stale) await utimes(cwd, old, old);
      return cwd;
    };
    const directory = async (root, runId, stale) => {
      const cwd = join(root, runId);
      await mkdir(cwd);
      if (stale) await utimes(cwd, old, old);
      return cwd;
    };
    const file = async (root, name, stale) => {
      const path = join(root, name);
      await writeFile(path, 'test');
      if (stale) await utimes(path, old, old);
      return path;
    };

    const staleWorktree = await worktree('stale-run', true);
    const protectedWorktree = await worktree('protected-run', true);
    const recentWorktree = await worktree('recent-run', false);
    const staleScratch = await directory(roots.scratch, 'stale-run', true);
    const protectedScratch = await directory(roots.scratch, 'protected-run', true);
    const liveScratch = await directory(roots.scratch, 'live-run', true);
    const staleSession = await file(roots.sessions, 'stale-run.jsonl', true);
    const protectedSession = await file(roots.sessions, 'protected-run.jsonl', true);
    const liveSession = await file(roots.sessions, 'live-run.jsonl', true);
    const recentSession = await file(roots.sessions, 'recent-run.jsonl', false);
    const staleConfig = await file(roots.configs, 'stale-run.yaml', true);
    const protectedConfig = await file(roots.configs, 'protected-run.yaml', true);

    const result = await cleanupRunnerStorage(
      {
        worktreeRetentionMs: 60 * 60_000,
        scratchRetentionMs: 60 * 60_000,
        sessionRetentionMs: 60 * 60_000,
        runs: [{ runId: 'protected-run', cwd: protectedWorktree, updatedAt: old.getTime(), protected: true }],
      },
      new Checkouts(() => null),
      ['live-run'],
    );

    assert.deepEqual(result, {
      removedWorktrees: 1,
      removedScratchDirs: 1,
      removedSessionFiles: 1,
      removedRunConfigs: 1,
      errors: [],
    });
    assert.equal(await exists(staleWorktree), false);
    assert.equal(await exists(staleScratch), false);
    assert.equal(await exists(staleSession), false);
    assert.equal(await exists(staleConfig), false);
    for (const path of [
      protectedWorktree,
      recentWorktree,
      protectedScratch,
      liveScratch,
      protectedSession,
      liveSession,
      recentSession,
      protectedConfig,
    ]) {
      assert.equal(await exists(path), true, `${path} should survive cleanup`);
    }
  } finally {
    if (previousHome === undefined) delete process.env.COMPANION_HOME;
    else process.env.COMPANION_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('worktree removal rejects paths outside Companion storage', async () => {
  const home = await mkdtemp(join(tmpdir(), 'companion-storage-boundary-'));
  const previousHome = process.env.COMPANION_HOME;
  process.env.COMPANION_HOME = home;
  try {
    const outside = await mkdtemp(join(tmpdir(), 'companion-operator-checkout-'));
    try {
      const checkouts = new Checkouts(() => null);
      await assert.rejects(() => checkouts.removeWorktree('acme/repo', outside), /outside the managed root/);
      assert.equal(await exists(outside), true);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  } finally {
    if (previousHome === undefined) delete process.env.COMPANION_HOME;
    else process.env.COMPANION_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test('cleanup removes a registered git worktree and prunes its administrative entry', async () => {
  const home = await mkdtemp(join(tmpdir(), 'companion-storage-git-'));
  const previousHome = process.env.COMPANION_HOME;
  process.env.COMPANION_HOME = home;
  try {
    const clone = join(home, 'repos', 'acme', 'repo');
    const worktree = join(home, 'worktrees', 'stale-git-run');
    await mkdir(clone, { recursive: true });
    await mkdir(join(home, 'worktrees'), { recursive: true });
    await execFileP('git', ['init', '-q', clone]);
    await writeFile(join(clone, 'README.md'), 'test\n');
    await execFileP('git', ['add', 'README.md'], { cwd: clone });
    await execFileP(
      'git',
      ['-c', 'user.name=Companion Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'initial'],
      { cwd: clone },
    );
    await execFileP('git', ['worktree', 'add', '-q', worktree], { cwd: clone });
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    await utimes(worktree, old, old);

    const result = await cleanupRunnerStorage(
      {
        worktreeRetentionMs: 60 * 60_000,
        scratchRetentionMs: 60 * 60_000,
        sessionRetentionMs: 60 * 60_000,
        runs: [],
      },
      new Checkouts(() => null),
    );

    assert.equal(result.removedWorktrees, 1);
    assert.deepEqual(result.errors, []);
    assert.equal(await exists(worktree), false);
    const { stdout } = await execFileP('git', ['worktree', 'list', '--porcelain'], { cwd: clone });
    assert.doesNotMatch(stdout, /stale-git-run/);
  } finally {
    if (previousHome === undefined) delete process.env.COMPANION_HOME;
    else process.env.COMPANION_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
