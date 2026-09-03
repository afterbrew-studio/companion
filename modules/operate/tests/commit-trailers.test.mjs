import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Checkouts } from '../dist/exec/index.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/** A worktree on a base commit, with whatever the agent left behind. */
function repoWith(trailerFile) {
  const cwd = mkdtempSync(join(tmpdir(), 'companion-trailers-'));
  git(cwd, 'init', '-b', 'main');
  git(cwd, 'config', 'user.name', 'Test');
  git(cwd, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(cwd, 'doc.md'), 'base\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-m', 'chore: base');
  git(cwd, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  writeFileSync(join(cwd, 'doc.md'), 'changed\n');
  if (trailerFile !== null) writeFileSync(join(cwd, '.companion-commit-trailers'), trailerFile);
  return cwd;
}

const commit = (cwd) =>
  new Checkouts(() => null).commitAll(
    cwd,
    'fix: reviewed work',
    { name: 'maintainer', email: 'maintainer@users.noreply.github.com' },
    'main',
  );

/**
 * The gap this closes: rayf refuses a change to a document it maps to code, or
 * to an accepted record, without a trailer explaining it. The daemon writes the
 * commit, so the lane could not satisfy those gates at all - correct work,
 * rejected forever, one repair cycle after another.
 */
test('an agent-declared trailer reaches the commit', async () => {
  const cwd = repoWith('doc-ownership(docs/x.md): the gate lists checkers and this adds none\n');
  try {
    await commit(cwd);
    const body = git(cwd, 'log', '-1', '--pretty=%B');
    assert.match(body, /^fix: reviewed work$/m);
    assert.match(body, /^doc-ownership\(docs\/x\.md\): the gate lists checkers and this adds none$/m);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('the trailer file is never committed', async () => {
  const cwd = repoWith('record-amendment(ADR-0078): the row described behaviour the code never had\n');
  try {
    await commit(cwd);
    assert.equal(existsSync(join(cwd, '.companion-commit-trailers')), false, 'removed from the worktree');
    const files = git(cwd, 'show', '--name-only', '--pretty=', 'HEAD');
    assert.ok(!files.includes('.companion-commit-trailers'), `staged anyway: ${files}`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('an agent cannot sign the commit as somebody else', async () => {
  // The base is reset before committing precisely so a model cannot attach
  // attribution. A trailer channel that allowed it would hand back what that
  // reset takes away.
  const cwd = repoWith(
    'Co-Authored-By: Somebody <nobody@example.com>\nSigned-off-by: Somebody <nobody@example.com>\ndoc-ownership(docs/x.md): kept\n',
  );
  try {
    await commit(cwd);
    const body = git(cwd, 'log', '-1', '--pretty=%B');
    assert.ok(!/co-authored-by/i.test(body), `attribution smuggled in: ${body}`);
    assert.ok(!/signed-off-by/i.test(body), `sign-off smuggled in: ${body}`);
    assert.match(body, /^doc-ownership\(docs\/x\.md\): kept$/m, 'the legitimate trailer still lands');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('an agent cannot close an issue through a trailer', async () => {
  const cwd = repoWith('Closes: #999\nFixes: #1000\ndoc-ownership(docs/x.md): kept\n');
  try {
    await commit(cwd);
    const body = git(cwd, 'log', '-1', '--pretty=%B');
    assert.ok(!/#999|#1000/.test(body), `issue closer smuggled in: ${body}`);
    assert.match(body, /^doc-ownership\(docs\/x\.md\): kept$/m);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('prose is not a trailer, and does not become the commit body', async () => {
  const cwd = repoWith('I could not work out which document owns this, so here is an essay instead.\n');
  try {
    await commit(cwd);
    assert.equal(git(cwd, 'log', '-1', '--pretty=%B'), 'fix: reviewed work');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('no file means the message is exactly what it was before', async () => {
  const cwd = repoWith(null);
  try {
    await commit(cwd);
    assert.equal(git(cwd, 'log', '-1', '--pretty=%B'), 'fix: reviewed work');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
