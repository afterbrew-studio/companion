import assert from 'node:assert/strict';
import test from 'node:test';
import { createLogger } from '../dist/lib/log.js';

/**
 * The level and format are read per call, not captured at construction, so
 * each case sets the env it needs and restores it. Output is captured rather
 * than asserted on a spy, because what matters is whether the operator sees a
 * line at all.
 */
function capture(level, run, format = null) {
  const before = process.env.COMPANION_LOG_LEVEL;
  const beforeFormat = process.env.COMPANION_LOG_FORMAT;
  if (level === null) delete process.env.COMPANION_LOG_LEVEL;
  else process.env.COMPANION_LOG_LEVEL = level;
  if (format === null) delete process.env.COMPANION_LOG_FORMAT;
  else process.env.COMPANION_LOG_FORMAT = format;
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
    if (beforeFormat === undefined) delete process.env.COMPANION_LOG_FORMAT;
    else process.env.COMPANION_LOG_FORMAT = beforeFormat;
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

test('pretty lines carry a full ISO date-time, not a dateless clock', () => {
  const lines = capture(null, (log) => log.info('booted'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[test\] booted/);
});

test('json format emits one parseable object per line', () => {
  const lines = capture(null, (log) => {
    log.info('listening');
    log.warn('slow start');
  }, 'json');
  assert.equal(lines.length, 2);
  const [info, warn] = lines.map((line) => JSON.parse(line));
  assert.equal(info.level, 'info');
  assert.equal(info.scope, 'test');
  assert.equal(info.msg, 'listening');
  assert.ok(Number.isFinite(Date.parse(info.ts)), `ts must be ISO8601, got ${info.ts}`);
  assert.match(info.ts, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.equal(warn.level, 'warn');
});

test('json format carries call-site fields as structured data', () => {
  const lines = capture(null, (log) => log.info('request failed', { path: '/api/x', attempt: 2 }), 'json');
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.path, '/api/x');
  assert.equal(parsed.attempt, 2);
});

test('json format keeps the reserved keys even when fields collide', () => {
  const lines = capture(null, (log) => log.info('real message', { msg: 'spoof', level: 'error' }), 'json');
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.msg, 'real message');
  assert.equal(parsed.level, 'info');
});

test('json errors serialize the stack instead of [object Object]', () => {
  const lines = capture(null, (log) => log.error('crashed', new Error('boom')), 'json');
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.level, 'error');
  assert.match(parsed.err, /Error: boom/);
});

test('json format survives a non-serializable field', () => {
  const circular = {};
  circular.self = circular;
  const lines = capture(null, (log) => log.info('kept', circular), 'json');
  assert.equal(JSON.parse(lines[0]).msg, 'kept');
});

test('the level filter applies identically in json format', () => {
  const lines = capture('warn', (log) => {
    log.debug('d');
    log.info('i');
    log.warn('w');
  }, 'json');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).level, 'warn');
});
