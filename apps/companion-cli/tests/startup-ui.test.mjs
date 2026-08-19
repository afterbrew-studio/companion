import assert from 'node:assert/strict';
import test from 'node:test';

import { renderAlreadyRunning, renderReady, renderStartup } from '../dist/startup-ui.js';

test('renders a quiet foreground startup card without terminal escapes', () => {
  const output = renderStartup({
    url: 'http://127.0.0.1:8901',
    home: '/tmp/companion',
    desk: true,
    background: false,
    verbose: false,
    logFile: '/tmp/companion/companion.log',
    color: false,
  });

  assert.match(output, /Companion Desk/);
  assert.match(output, /quiet while starting · use --verbose/);
  assert.match(output, /Data\s+\/tmp\/companion/);
  assert.doesNotMatch(output, /\x1b\[/);
});

test('renders foreground and background ready states', () => {
  const foreground = renderReady('http://127.0.0.1:8901', true, false);
  const background = renderReady('http://127.0.0.1:8901', false, false);

  assert.match(foreground, /●  Ready/);
  assert.match(foreground, /Press Ctrl\+C to stop\./);
  assert.doesNotMatch(background, /Ctrl\+C/);
  assert.ok(foreground.endsWith('\n\n'));
});

test('adds color only when the terminal supports it', () => {
  const plain = renderAlreadyRunning('http://127.0.0.1:8901', 123, false);
  const colored = renderAlreadyRunning('http://127.0.0.1:8901', 123, true);

  assert.doesNotMatch(plain, /\x1b\[/);
  assert.match(colored, /\x1b\[/);
  assert.match(plain, /npx @moxxy\/companion stop/);
});
