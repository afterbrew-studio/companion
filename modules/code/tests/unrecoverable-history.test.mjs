import assert from 'node:assert/strict';
import test from 'node:test';
import {
  commitViolatesOwnership,
  judgeOwnedHistory,
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

/**
 * The three answers have to stay distinguishable. A commit whose file list came
 * back empty matches no `when` glob, so under a nullable verdict it read as a
 * clean history - the pull request stayed unrepairable and nothing said why.
 */
test('an unreadable file list is not a clean history', () => {
  const verdict = judgeOwnedHistory(
    [
      { sha: 'aaa111', message: 'fix: silence a gate\n', files: [] },
      { sha: 'bbb222', message: 'fix: repair\n', files: ['scripts/check.sh', 'AGENTS.md'] },
    ],
    RAYF_RULES,
  );
  assert.deepEqual(verdict, { kind: 'unreadable', sha: 'aaa111' });
});

test('a genuinely clean history says clean, not unreadable', () => {
  const verdict = judgeOwnedHistory(
    [
      { sha: 'aaa111', message: 'docs: prose\n', files: ['docs/product.md'] },
      { sha: 'bbb222', message: 'docs: more\n', files: ['docs/product.md'] },
    ],
    RAYF_RULES,
  );
  assert.deepEqual(verdict, { kind: 'clean' });
});

test('an unrecoverable ancestor is named, not merely flagged', () => {
  const verdict = judgeOwnedHistory(
    [
      { sha: 'aaa111', message: 'fix: silence a gate\n', files: ['scripts/check.sh'] },
      { sha: 'bbb222', message: 'fix: repair\n', files: ['scripts/check.sh', 'AGENTS.md'] },
    ],
    RAYF_RULES,
  );
  assert.equal(verdict.kind, 'unrecoverable');
  assert.equal(verdict.commit?.sha, 'aaa111');
});

test('one commit has no ancestor to be stuck on', () => {
  assert.deepEqual(
    judgeOwnedHistory([{ sha: 'aaa111', message: 'x\n', files: ['scripts/check.sh'] }], RAYF_RULES),
    { kind: 'no-ancestor' },
  );
});
