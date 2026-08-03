import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { Checkouts, parseDiffNumstat } from '../dist/exec/index.js';

const execFileP = promisify(execFile);

test('numstat planning counts text, binary, mode-only and renamed files', () => {
  const output = [
    '12\t3\tsrc/main.ts',
    '-\t-\tassets/logo.png',
    '0\t0\tscripts/run.sh',
    '4\t1\t',
    'src/old name.ts',
    'src/new name.ts',
    '',
  ].join('\0');

  assert.deepEqual(parseDiffNumstat(output), [
    { path: 'src/main.ts', changed: 15 },
    { path: 'assets/logo.png', changed: 1 },
    { path: 'scripts/run.sh', changed: 1 },
    { path: 'src/new name.ts', changed: 5 },
  ]);
});

test('numstat paths may contain tabs and newlines without changing record boundaries', () => {
  assert.deepEqual(parseDiffNumstat('1\t2\todd\tname\n.ts\0'), [
    { path: 'odd\tname\n.ts', changed: 3 },
  ]);
});

test('malformed numstat fails closed instead of omitting review coverage', () => {
  assert.throws(() => parseDiffNumstat('not-a-record\0'), /malformed/);
  assert.throws(() => parseDiffNumstat('x\t2\tfile.ts\0'), /invalid line counts/);
  assert.throws(() => parseDiffNumstat('1\t2\t\0old.ts\0'), /without a path/);
});

test('checkout planning reads a real rename without materialising the full patch', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'companion-numstat-'));
  const git = (...args) => execFileP('git', args, { cwd: repo });
  try {
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.name', 'Companion Test');
    await git('config', 'user.email', 'companion@example.test');
    await writeFile(join(repo, 'old name.ts'), 'export const value = 1;\n');
    await git('add', '.');
    await git('commit', '-qm', 'base');
    await git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    await rename(join(repo, 'old name.ts'), join(repo, 'new name.ts'));
    await git('add', '-A');
    await git('commit', '-qm', 'change');

    const files = await new Checkouts(() => null).diffFileSizes(repo, 'main');
    assert.deepEqual(files, [{ path: 'new name.ts', changed: 1 }]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('bounded PR diff stops before a giant patch is materialised', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'companion-bounded-diff-'));
  const git = (...args) => execFileP('git', args, { cwd: repo });
  try {
    await git('init', '-q', '-b', 'main');
    await git('config', 'user.name', 'Companion Test');
    await git('config', 'user.email', 'companion@example.test');
    await writeFile(join(repo, 'large.txt'), 'base\n');
    await git('add', '.');
    await git('commit', '-qm', 'base');
    await git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    await writeFile(join(repo, 'large.txt'), `${'changed-content-'.repeat(20_000)}\n`);
    await git('add', '.');
    await git('commit', '-qm', 'large change');

    const checkouts = new Checkouts(() => null);
    assert.equal(await checkouts.diffVsBaseBounded(repo, 'main', 8_000), null);
    assert.match(await checkouts.diffVsBaseBounded(repo, 'main', 512_000), /changed-content/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
