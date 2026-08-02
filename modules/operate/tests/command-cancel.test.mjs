import assert from 'node:assert/strict';
import test from 'node:test';
import { runCommand } from '../dist/exec/verify.js';

test('aborting an executable step kills its whole local process group promptly', async () => {
  const controller = new AbortController();
  const command = `"${process.execPath}" -e "setInterval(() => {}, 1000)"`;
  const pending = runCommand(process.cwd(), command, { timeoutMs: 30_000, signal: controller.signal });
  setTimeout(() => controller.abort('pipeline cancelled'), 50).unref();

  const result = await pending;
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, null);
  assert.ok(result.durationMs < 3_000, `command took ${result.durationMs}ms to stop`);
});
