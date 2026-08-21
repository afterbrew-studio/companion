import assert from 'node:assert/strict';
import test from 'node:test';

import { renderAlreadyRunning, renderReady, renderStartup, renderStartupStep } from '../dist/startup-ui.js';

test('renders a quiet foreground startup card without terminal escapes', () => {
  const output = renderStartup({
    url: 'http://127.0.0.1:8901',
    home: '/tmp/companion',
    desk: true,
    background: false,
    verbose: false,
    logFile: '/tmp/companion/companion.log',
    authMode: 'local',
    color: false,
  });

  assert.match(output, /Companion Desk/);
  assert.match(output, /quiet while starting · use --verbose/);
  assert.match(output, /Data\s+\/tmp\/companion/);
  assert.match(output, /Access\s+local superadmin · loopback only/);
  assert.match(output, /Run\s+foreground/);
  assert.doesNotMatch(output, /\x1b\[/);
});

test('renders structured first-run steps', () => {
  const success = renderStartupStep('Modules', 'plan, board', false);
  const warning = renderStartupStep('Repository', 'unavailable', false, 'warning');

  assert.match(success, /✓  Modules\s+plan, board/);
  assert.match(warning, /!  Repository\s+unavailable/);
  assert.doesNotMatch(success, /\x1b\[/);
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
