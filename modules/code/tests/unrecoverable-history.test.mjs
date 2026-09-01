import assert from 'node:assert/strict';
import test from 'node:test';
import { unrecoverableOwnedAncestor } from '../dist/api/unrecoverable-history.js';

test('a trailer-less owned-path ancestor is unrecoverable even when HEAD is clean', () => {
  const ancestor = unrecoverableOwnedAncestor(
    [
      { sha: 'aaa111', message: 'docs: mention the command\n' },
      { sha: 'bbb222', message: 'docs: mention the command\n\ndoc-ownership(AGENTS.md): added a command\n' },
    ],
    ['AGENTS.md', 'docs/product.md'],
  );
  assert.equal(ancestor?.sha, 'aaa111');
});

test('a single clean commit is not unrecoverable history', () => {
  assert.equal(
    unrecoverableOwnedAncestor(
      [{ sha: 'bbb222', message: 'docs: mention the command\n\ndoc-ownership(AGENTS.md): added a command\n' }],
      ['AGENTS.md'],
    ),
    null,
  );
});

test('a range that never touches owned paths is left to ordinary fix_ci', () => {
  assert.equal(
    unrecoverableOwnedAncestor(
      [
        { sha: 'aaa111', message: 'fix: a test\n' },
        { sha: 'bbb222', message: 'fix: a test better\n' },
      ],
      ['Packages/Foo/Sources/Bar.swift'],
    ),
    null,
  );
});
