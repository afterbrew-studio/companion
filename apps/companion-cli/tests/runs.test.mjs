import assert from 'node:assert/strict';
import test from 'node:test';
import { RUN_HELP, parseRunCommand } from '../dist/runs.js';

test('every documented command parses', () => {
  // The help text is the contract; a command it advertises and the parser rejects
  // is the worst kind of bug in a CLI.
  for (const action of ['list', 'show', 'diff', 'approve', 'discard']) {
    const argv = action === 'list' ? [action] : [action, 'run-abc'];
    assert.equal(parseRunCommand(argv).action, action);
  }
});

test('an unknown command names itself and shows the help', () => {
  assert.throws(() => parseRunCommand(['frobnicate']), /Unknown run command: frobnicate/);
  assert.throws(() => parseRunCommand(['frobnicate']), /companion run <command>/);
});

test('a command that needs a run id says so instead of acting on nothing', () => {
  for (const action of ['show', 'diff', 'approve', 'discard']) {
    assert.throws(() => parseRunCommand([action]), /needs a run id/, action);
  }
});

test('list needs no id', () => {
  assert.equal(parseRunCommand(['list']).id, undefined);
});

test('the run id is positional and the flags are not confused for it', () => {
  const cmd = parseRunCommand(['approve', '--title', 'Fix the thing', 'run-abc', '--json']);
  assert.equal(cmd.id, 'run-abc');
  assert.equal(cmd.title, 'Fix the thing');
  assert.equal(cmd.json, true);
});

test('--title without a value is refused rather than swallowing the next flag', () => {
  assert.throws(() => parseRunCommand(['approve', 'run-abc', '--title']), /--title needs a value/);
});

test('an unknown flag is refused, so a typo does not silently do the wrong thing', () => {
  assert.throws(() => parseRunCommand(['list', '--evrything']), /Unknown argument: --evrything/);
});

test('a second positional is refused rather than quietly ignored', () => {
  assert.throws(() => parseRunCommand(['diff', 'run-a', 'run-b']), /Unknown argument: run-b/);
});

test('--yes has a short form, because discard is the one you type often', () => {
  assert.equal(parseRunCommand(['discard', 'run-abc', '-y']).yes, true);
  assert.equal(parseRunCommand(['discard', 'run-abc', '--yes']).yes, true);
  assert.equal(parseRunCommand(['discard', 'run-abc']).yes, false);
});

test('list defaults to actionable runs, with --all as the opt-out', () => {
  assert.equal(parseRunCommand(['list']).all, false);
  assert.equal(parseRunCommand(['list', '--all']).all, true);
});

test('the help documents the piping the diff command is designed for', () => {
  assert.match(RUN_HELP, /companion run diff .* \| delta/);
});
