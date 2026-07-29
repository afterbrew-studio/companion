import assert from 'node:assert/strict';
import test from 'node:test';
// The client slice is never built to dist (Vite reads it from source), so this
// imports the real module and lets node strip the types.
import { emptyFold, foldEvent, foldMany } from '../src/client/transcript/fold.ts';

/**
 * moxxy retries provider failures itself: react-loop backs off up to six times
 * and reports every attempt as an `error` event with `kind: 'retryable'` while
 * the turn is still running, emitting `kind: 'fatal'` only when it gives up.
 * The fold's job is to keep those apart.
 *
 * Every fixture below sends the SAME provider text under different kinds. A
 * fixture that varied the message too could not tell "the fold read the kind"
 * from "the fold pattern-matched the words", which is the bug being fixed.
 */
const OVERLOADED = 'Our servers are currently overloaded. Please try again later.';

const errorEvent = (overrides) => ({
  id: `e-${Math.random().toString(36).slice(2)}`,
  seq: 1,
  ts: Date.now(),
  sessionId: 's1',
  turnId: 't1',
  source: 'system',
  type: 'error',
  message: OVERLOADED,
  ...overrides,
});

const notices = (...events) => foldMany(emptyFold(), events).blocks.filter((b) => b.kind === 'notice');
const only = (...events) => {
  const found = notices(...events);
  assert.equal(found.length, 1, 'expected exactly one notice block');
  return found[0];
};

test('a retryable provider error does not render as a failure', () => {
  const block = only(errorEvent({ kind: 'retryable' }));

  assert.notEqual(block.level, 'error', 'moxxy is still retrying — this run is not dead');
  assert.equal(block.level, 'warn');
  assert.equal(block.title, 'Recoverable error');
  // The provider's own wording still reaches the operator; only the framing changed.
  assert.equal(block.text, OVERLOADED);
});

test('a fatal provider error still renders as a failure', () => {
  const block = only(errorEvent({ kind: 'fatal' }));

  assert.equal(block.level, 'error');
  assert.equal(block.title, 'Run error');
  assert.equal(block.text, OVERLOADED);
});

test('severity follows kind, not the message text', () => {
  // Identical text, opposite verdicts: nothing here can be explained by the
  // words, so the fold must be reading `kind`.
  const retryable = only(errorEvent({ kind: 'retryable' }));
  const fatal = only(errorEvent({ kind: 'fatal' }));
  assert.notEqual(retryable.level, fatal.level);

  // And a fatal error with no message at all is still a failure: presence of
  // text decides nothing.
  const empty = only(errorEvent({ kind: 'fatal', message: '' }));
  assert.equal(empty.level, 'error');
  assert.equal(empty.text, 'error');
});

test('every non-fatal kind is named, and none of them reads as a dead run', () => {
  const expected = {
    retryable: 'Recoverable error',
    tool_threw: 'Tool error',
    hook_failed: 'Hook failed',
    provider_failed: 'Provider error',
  };
  for (const [kind, title] of Object.entries(expected)) {
    const block = only(errorEvent({ kind }));
    assert.equal(block.title, title, `${kind} should be named`);
    assert.equal(block.level, 'warn', `${kind} must not read as a failure`);
  }
});

test('an unknown or missing kind lands where the server puts it', () => {
  // Orchestrator.onEvent records a run outcome on `kind === 'fatal'` and on
  // nothing else. A kind this fold has never seen must fall on that same side,
  // or the transcript claims a death the run record does not have.
  for (const kind of [undefined, '', 'some_future_kind']) {
    const block = only(errorEvent({ kind }));
    assert.equal(block.level, 'warn', `kind=${String(kind)} must not be promoted to a failure`);
    assert.equal(block.title, 'Warning');
  }
});

test('the attempt number is shown when moxxy reports one, and invented when it does not', () => {
  assert.equal(only(errorEvent({ kind: 'retryable', attempt: 3 })).attempt, 3);
  // No producer in moxxy's react-loop sets `attempt` today, so the common case
  // must not render a bogus "attempt 0".
  assert.equal(only(errorEvent({ kind: 'retryable' })).attempt, undefined);
  assert.equal(only(errorEvent({ kind: 'retryable', attempt: 0 })).attempt, undefined);
});

test('a run that retries and then dies shows the whole story', () => {
  const blocks = notices(
    errorEvent({ id: 'a', kind: 'retryable' }),
    errorEvent({ id: 'b', kind: 'retryable' }),
    errorEvent({ id: 'c', kind: 'fatal', message: 'provider kept returning a retryable error 6 times in a row' }),
  );

  assert.deepEqual(
    blocks.map((b) => b.level),
    ['warn', 'warn', 'error'],
  );
});

test('unrelated notices are untouched', () => {
  const state = foldEvent(emptyFold(), {
    id: 'ab',
    seq: 9,
    ts: Date.now(),
    sessionId: 's1',
    turnId: 't1',
    source: 'system',
    type: 'abort',
  });
  assert.deepEqual(state.blocks, [{ kind: 'notice', key: 'ab', level: 'info', text: 'Turn aborted' }]);
});
