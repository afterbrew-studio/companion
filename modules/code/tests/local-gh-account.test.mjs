import assert from 'node:assert/strict';
import test from 'node:test';
import { readActiveLocalGhAccount } from '../dist/api/local-gh-account.js';

test('a password-mode admin never inherits the host operator gh credential', async () => {
  // This must return before probing gh. The test is intentionally valid on a
  // maintainer machine that has a real active account — the environment that
  // exposed the privilege crossover in the real-daemon smoke.
  assert.equal(await readActiveLocalGhAccount('github.com', 'password'), null);
});

test('trusted local import keeps its explicit operator opt-out', async () => {
  const previous = process.env.COMPANION_IMPORT_LOCAL_GH;
  process.env.COMPANION_IMPORT_LOCAL_GH = 'false';
  try {
    assert.equal(await readActiveLocalGhAccount('github.com', 'local'), null);
  } finally {
    if (previous === undefined) delete process.env.COMPANION_IMPORT_LOCAL_GH;
    else process.env.COMPANION_IMPORT_LOCAL_GH = previous;
  }
});
