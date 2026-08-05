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
