import assert from 'node:assert/strict';
import test from 'node:test';
import { parseModuleCommand } from '../dist/modules.js';

/**
 * Argument parsing only. What `add` and `remove` then DO lives in
 * `@moxxy/companion-core/server` beside the daemon routes that call the same
 * functions, and is tested there against real `npm pack` output.
 */

test('add takes a spec rather than an id, and carries --force', () => {
  const cmd = parseModuleCommand(['add', 'companion-module-reports@1.2.0', '--force']);
  assert.equal(cmd.action, 'add');
  assert.equal(cmd.id, 'companion-module-reports@1.2.0');
  assert.equal(cmd.force, true);

  assert.throws(() => parseModuleCommand(['add']), /requires a package spec/);
});

test('remove takes a module id, and --yes for a script', () => {
  const cmd = parseModuleCommand(['remove', 'reports', '--yes']);
  assert.equal(cmd.action, 'remove');
  assert.equal(cmd.id, 'reports');
  assert.equal(cmd.yes, true);

  // Without an id there is nothing to delete, and guessing is not an option.
  assert.throws(() => parseModuleCommand(['remove']), /requires a module id/);
});
