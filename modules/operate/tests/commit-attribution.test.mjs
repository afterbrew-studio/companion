import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Checkouts } from '../dist/exec/index.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

test('fresh PR commit collapses agent commits and their attribution onto the trusted base', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'companion-clean-commit-'));
  try {
    git(cwd, 'init', '-b', 'main');
    git(cwd, 'config', 'user.name', 'Test');
    git(cwd, 'config', 'user.email', 'test@example.com');
    writeFileSync(join(cwd, 'change.txt'), 'base\n');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-m', 'chore: base');
    git(cwd, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(cwd, 'checkout', '-b', 'agent');

    appendFileSync(join(cwd, 'change.txt'), 'agent commit\n');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-m', 'fix: agent work\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
    appendFileSync(join(cwd, 'change.txt'), 'uncommitted tail\n');

    await new Checkouts(() => null).commitAll(
      cwd,
      'fix: reviewed work',
      { name: 'maintainer', email: 'maintainer@users.noreply.github.com' },
      'main',
    );

    assert.equal(git(cwd, 'rev-list', '--count', 'origin/main..HEAD'), '1');
    assert.equal(git(cwd, 'log', '-1', '--pretty=%B'), 'fix: reviewed work');
    assert.equal(
      git(cwd, 'log', '-1', '--pretty=%an <%ae>'),
      'maintainer <maintainer@users.noreply.github.com>',
    );
    assert.equal(git(cwd, 'show', 'HEAD:change.txt'), 'base\nagent commit\nuncommitted tail');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

/**
 * An agent asked to leave its changes uncommitted can still reach for
 * `git reset` or `git rebase`. On an existing pull request that rewrote the
 * branch under itself: HEAD ended up a sibling of the branch rather than a
 * descendant, and the push was rejected non-fast-forward after the whole turn
 * had been spent. Resetting onto the branch's own remote tip keeps the tree and
 * makes the commit a descendant again.
 */
test('a repair commits onto the pull request branch even after the agent rewrote it', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'companion-repair-commit-'));
  try {
    git(cwd, 'init', '-b', 'main');
    git(cwd, 'config', 'user.name', 'Test');
    git(cwd, 'config', 'user.email', 'test@example.com');
    writeFileSync(join(cwd, 'f.txt'), 'base\n');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-m', 'chore: base');
    git(cwd, 'update-ref', 'refs/remotes/origin/main', 'HEAD');

    // The pull request branch: two commits past main, as a card that already
    // built and repaired once leaves it.
    git(cwd, 'checkout', '-q', '-b', 'feat');
    appendFileSync(join(cwd, 'f.txt'), 'built\n');
    git(cwd, 'commit', '-qam', 'feat: built');
    appendFileSync(join(cwd, 'f.txt'), 'repaired\n');
    git(cwd, 'commit', '-qam', 'fix: repaired once');
    const tip = git(cwd, 'rev-parse', 'HEAD');
    git(cwd, 'update-ref', 'refs/remotes/origin/feat', tip);

    // The agent resets onto the base and commits, which is the observed defect.
    git(cwd, 'reset', '-q', '--hard', 'origin/main');
    appendFileSync(join(cwd, 'f.txt'), 'agent work\n');
    git(cwd, 'commit', '-qam', 'wip: agent');
    assert.equal(git(cwd, 'merge-base', 'HEAD', tip), git(cwd, 'rev-parse', 'origin/main'));

    await new Checkouts(() => null).commitAll(
      cwd,
      'fix: reviewed repair',
      { name: 'maintainer', email: 'maintainer@users.noreply.github.com' },
      'feat',
    );

    assert.equal(git(cwd, 'rev-parse', 'HEAD~1'), tip, 'the branch tip is the parent');
    assert.equal(git(cwd, 'rev-list', '--count', `${tip}..HEAD`), '1');
    assert.equal(git(cwd, 'log', '-1', '--pretty=%B'), 'fix: reviewed repair');
    assert.match(git(cwd, 'show', 'HEAD:f.txt'), /agent work/, 'the agent tree survives');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
