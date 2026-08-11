import assert from 'node:assert/strict';
import test from 'node:test';
import { chunkScrubber, redact } from '../dist/api/pipelines.js';

test('injected values of eight characters or more are scrubbed', () => {
  assert.equal(redact('token=abcdefgh rest', ['abcdefgh']), 'token=*** rest');
});

test('injected values down to four characters are scrubbed', () => {
  assert.equal(redact('pin is 7351 and again 7351', ['7351']), 'pin is *** and again ***');
  assert.equal(redact('key=abcd', ['abcd']), 'key=***');
});

test('values of one to three characters are never redacted', () => {
  // Redacting them would asterisk ordinary output wholesale; they are also
  // refused at secret-set time, so this is belt only, not policy.
  assert.equal(redact('a 1 b 12 c 123', ['1', '12', '123']), 'a 1 b 12 c 123');
  assert.equal(redact('anything', ['']), 'anything');
});

test('a short secret split across stream chunks is still scrubbed', () => {
  const scrubber = chunkScrubber(['7351']);
  const out = scrubber.push('pin is 73') + scrubber.push('51 done') + scrubber.flush();
  assert.equal(out, 'pin is *** done');
});

test('a hidden pipeline variable shorter than 4 chars is refused at validation', async () => {
  const { pipelineStepSchema } = await import('../dist/api/pipelines.js');
  const step = (value) => ({
    kind: 'executable',
    name: 'publish',
    onFailure: 'halt',
    config: {
      command: 'echo ok',
      workdir: 'clone',
      timeoutMs: 60_000,
      variables: [{ name: 'NPM_TOKEN', hidden: true, value }],
    },
  });
  const short = pipelineStepSchema.safeParse(step('abc'));
  assert.equal(short.success, false);
  assert.match(JSON.stringify(short.error.issues), /cannot be redacted/);
  assert.equal(pipelineStepSchema.safeParse(step('abcd')).success, true);
});
