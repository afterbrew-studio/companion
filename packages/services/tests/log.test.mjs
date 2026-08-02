import assert from 'node:assert/strict';
import test from 'node:test';
import { createLogger } from '../dist/lib/log.js';

/**
 * The level is read per call, not captured at construction, so each case sets
 * the env it needs and restores it. Output is captured rather than asserted on
 * a spy, because what matters is whether the operator sees a line at all.
 */
function capture(level, run) {
  const before = process.env.COMPANION_LOG_LEVEL;
  if (level === null) delete process.env.COMPANION_LOG_LEVEL;
  else process.env.COMPANION_LOG_LEVEL = level;
  const lines = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...args) => lines.push(args.map(String).join(' '));
  console.warn = console.log;
  console.error = console.log;
  try {
    run(createLogger('test'));
  } finally {
    Object.assign(console, original);
    if (before === undefined) delete process.env.COMPANION_LOG_LEVEL;
    else process.env.COMPANION_LOG_LEVEL = before;
  }
  return lines;
}

test('debug is silent by default, so a normal boot stays readable', () => {
  const lines = capture(null, (log) => log.debug('expected lifecycle detail'));
  assert.deepEqual(lines, []);
});

test('debug appears once it is asked for', () => {
  const lines = capture('debug', (log) => log.debug('expected lifecycle detail'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /DEBUG expected lifecycle detail/);
});

test('turning debug on does not silence anything above it', () => {
  const lines = capture('debug', (log) => {
    log.info('i');
    log.warn('w');
    log.error('e');
  });
  assert.equal(lines.length, 3);
});

test('a raised level still hides debug and info', () => {
  const lines = capture('warn', (log) => {
    log.debug('d');
    log.info('i');
    log.warn('w');
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /WARN w/);
});

test('silent means silent, debug included', () => {
  const lines = capture('silent', (log) => {
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
  });
  assert.deepEqual(lines, []);
});
