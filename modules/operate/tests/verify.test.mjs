import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_VERIFY_TIMEOUT_MS, runVerify } from '../dist/exec/verify.js';

function cwd(t) {
  const dir = mkdtempSync(join(tmpdir(), 'companion-verify-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a passing command reports exit 0', async (t) => {
  const outcome = await runVerify(cwd(t), 'exit 0');
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.timedOut, false);
});

test('a failing command reports its exit code, not an exception', async (t) => {
  const outcome = await runVerify(cwd(t), 'exit 3');
  assert.equal(outcome.exitCode, 3);
});

test('output is captured from both streams, because builds complain on stderr', async (t) => {
  const outcome = await runVerify(cwd(t), 'echo to-stdout; echo to-stderr 1>&2');
  assert.match(outcome.output, /to-stdout/);
  assert.match(outcome.output, /to-stderr/);
});

test('the command runs IN the worktree, which is the whole point', async (t) => {
  const dir = cwd(t);
  writeFileSync(join(dir, 'marker.txt'), 'x');
  const outcome = await runVerify(dir, 'cat marker.txt');
  assert.equal(outcome.exitCode, 0);
  assert.match(outcome.output, /x/);
});

test('shell syntax works, because that is what people put in this field', async (t) => {
  const outcome = await runVerify(cwd(t), 'true && echo both');
  assert.equal(outcome.exitCode, 0);
  assert.match(outcome.output, /both/);
});

test('a missing binary is a failure with a readable reason, never a throw', async (t) => {
  const outcome = await runVerify(cwd(t), 'definitely-not-a-real-binary-xyz');
  assert.notEqual(outcome.exitCode, 0);
  assert.ok(outcome.output.length > 0, 'a silent failure tells a reviewer nothing');
});

test('the TAIL of a long output is kept, since a build says what broke at the end', async (t) => {
  // 20k lines of progress noise, then the actual error.
  const outcome = await runVerify(cwd(t), 'for i in $(seq 1 20000); do echo noise-$i; done; echo THE-REAL-ERROR 1>&2');
  assert.match(outcome.output, /THE-REAL-ERROR/);
  assert.ok(outcome.output.length <= 8_000, `output was ${outcome.output.length} chars, not clipped`);
});

test('a hanging command is killed and flagged as timed out, not left running', async (t) => {
  const outcome = await runVerify(cwd(t), 'sleep 30', 300);
  assert.equal(outcome.timedOut, true);
  assert.notEqual(outcome.exitCode, 0);
});

test('a command that waits on stdin cannot hang forever on a prompt nobody sees', async (t) => {
  // stdin is 'ignore', so a read returns EOF immediately instead of blocking.
  const outcome = await runVerify(cwd(t), 'cat', 5_000);
  assert.equal(outcome.timedOut, false);
});

test('duration is measured, so a slow verification is visible as slow', async (t) => {
  const outcome = await runVerify(cwd(t), 'sleep 0.2');
  assert.ok(outcome.durationMs >= 150, `durationMs was ${outcome.durationMs}`);
});

test('CI is set, so tooling picks its non-interactive path', async (t) => {
  const outcome = await runVerify(cwd(t), 'echo "ci=$CI"');
  assert.match(outcome.output, /ci=1/);
});

test('the default timeout is a ceiling, not a target', () => {
  assert.equal(DEFAULT_VERIFY_TIMEOUT_MS, 10 * 60_000);
});
