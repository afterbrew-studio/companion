import assert from 'node:assert/strict';
import test from 'node:test';
import {
  commitViolatesOwnership,
  parseOwnershipRules,
  pathMatches,
  unrecoverableOwnedAncestor,
} from '../dist/api/unrecoverable-history.js';

const RAYF_RULES = [
  { when: ['scripts/check.sh', 'scripts/verify_gates.sh'], update: ['AGENTS.md'] },
  { when: ['Packages/**', 'App/**'], update: ['ARCHITECTURE.md', 'docs/technical-spec.md'] },
];

test('an ancestor that touched a watched path without its owning document is unrecoverable', () => {
  const ancestor = unrecoverableOwnedAncestor(
    [
      { sha: 'aaa111', message: 'fix: silence a gate\n', files: ['scripts/check.sh'] },
      { sha: 'bbb222', message: 'fix: silence a gate\n\ndoc-ownership(AGENTS.md): internal\n', files: ['scripts/check.sh', 'AGENTS.md'] },
    ],
    RAYF_RULES,
  );
  assert.equal(ancestor?.sha, 'aaa111');
});

test('a docs-only ancestor is not unrecoverable: docs are the update side', () => {
  assert.equal(
    unrecoverableOwnedAncestor(
      [
        { sha: 'aaa111', message: 'docs: mention the command\n', files: ['docs/product.md'] },
        { sha: 'bbb222', message: 'docs: mention the command again\n', files: ['docs/product.md'] },
      ],
      RAYF_RULES,
    ),
    null,
  );
});

test('a trailer on the ancestor is the intended escape', () => {
  assert.equal(
    unrecoverableOwnedAncestor(
      [
        {
          sha: 'aaa111',
          message: 'fix: a probe\n\ndoc-ownership(AGENTS.md): added probes, no new command\n',
          files: ['scripts/verify_gates.sh'],
        },
        { sha: 'bbb222', message: 'fix: follow-up\n', files: ['scripts/lint/foo.py'] },
      ],
      RAYF_RULES,
    ),
    null,
  );
});

test('a single clean commit is not unrecoverable history', () => {
  assert.equal(
    unrecoverableOwnedAncestor(
      [{ sha: 'bbb222', message: 'fix: a test\n', files: ['scripts/check.sh'] }],
      RAYF_RULES,
    ),
    null,
  );
});

test('no ownership map means the detector does not guess', () => {
  assert.equal(
    unrecoverableOwnedAncestor(
      [
        { sha: 'aaa111', message: 'fix: a test\n', files: ['scripts/check.sh'] },
        { sha: 'bbb222', message: 'fix: a test better\n', files: ['scripts/check.sh'] },
      ],
      [],
    ),
    null,
  );
});

test('parseOwnershipRules reads the when/update map', () => {
  const rules = parseOwnershipRules(
    JSON.stringify({
      rules: [{ when: ['scripts/check.sh'], update: ['AGENTS.md'], why: 'x' }],
    }),
  );
  assert.equal(pathMatches('scripts/check.sh', 'scripts/check.sh'), true);
  assert.equal(pathMatches('Packages/Foo/Bar.swift', 'Packages/**'), true);
  assert.equal(
    commitViolatesOwnership({ sha: 'a', message: 'm', files: ['scripts/check.sh'] }, rules),
    true,
  );
});
