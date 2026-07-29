import assert from 'node:assert/strict';
import test from 'node:test';
import { BoardService } from '../dist/api/board-service.js';

/**
 * The gate is a private method, reached the way the class itself does. Testing it
 * directly is the point: the branch that matters ('wait') is invisible in any
 * end-to-end run, because it exists precisely to do nothing.
 */
const gate = (verification) => BoardService.prototype.verificationGate.call(null, verification);
const reason = (verification) => BoardService.prototype.verificationReason.call(null, verification);

const verification = (over) => ({
  status: 'passed',
  command: 'pnpm -s typecheck',
  exitCode: 0,
  output: '',
  timedOut: false,
  durationMs: 1_200,
  at: 1_700_000_000_000,
  ...over,
});

test('a passing verification opens the PR', () => {
  assert.equal(gate(verification({ status: 'passed' })), 'proceed');
});

test('a failing verification goes back for another attempt', () => {
  // The whole point: retry off the cheap signal rather than spending a PR and a
  // CI run to learn the same thing.
  assert.equal(gate(verification({ status: 'failed', exitCode: 1 })), 'retry');
});

test('a verification still running waits, rather than shipping before the answer', () => {
  // Verification starts AFTER the run enters review, so the first run.changed for
  // that transition says 'running'. Acting on it would defeat the feature.
  assert.equal(gate(verification({ status: 'running' })), 'wait');
});

test('an unavailable verification proceeds, because it is not evidence', () => {
  // No command configured, or a runner too old to check. Refusing to ship on this
  // would break every repository that never opted in.
  assert.equal(gate(verification({ status: 'unavailable' })), 'proceed');
});

test('no verification at all proceeds, which is every pre-existing run', () => {
  assert.equal(gate(null), 'proceed');
});

test('an absent field proceeds too, because a bus event may predate it', () => {
  // Caught by an existing dead-run test: a record built without the field made the
  // gate throw, which would have taken down the board's reaction to every run.
  assert.equal(gate(undefined), 'proceed');
});

test('the retry reason carries the command and the output, so the next attempt knows', () => {
  const text = reason(verification({ status: 'failed', exitCode: 2, output: 'TS2304: Cannot find name x' }));
  assert.match(text, /pnpm -s typecheck/);
  assert.match(text, /exited 2/);
  assert.match(text, /TS2304/);
});

test('a timeout is described as a timeout, not as an exit code', () => {
  const text = reason(verification({ status: 'failed', exitCode: null, timedOut: true }));
  assert.match(text, /timed out/);
  assert.doesNotMatch(text, /exited null/);
});

test('a death on a signal is not reported as an exit code either', () => {
  assert.match(reason(verification({ status: 'failed', exitCode: null })), /on a signal/);
});

test('the reason is clipped, so a huge build log cannot bloat every retry prompt', () => {
  const text = reason(verification({ status: 'failed', exitCode: 1, output: 'x'.repeat(50_000) }));
  assert.ok(text.length <= 2_000, `reason was ${text.length} chars`);
});

test('a missing verification still yields a usable reason rather than crashing', () => {
  assert.equal(reason(null), 'verification failed');
});
