import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { isLoopbackHost, isTrustedLocalHttpRequest, loadDaemonConfig } from '../dist/index.js';

function withHome(run) {
  const home = mkdtempSync(join(tmpdir(), 'companion-config-'));
  const previous = process.env.COMPANION_HOME;
  process.env.COMPANION_HOME = home;
  try {
    return run(home);
  } finally {
    if (previous === undefined) delete process.env.COMPANION_HOME;
    else process.env.COMPANION_HOME = previous;
    delete process.env.COMPANION_AUTH_MODE;
    delete process.env.COMPANION_HOST;
    rmSync(home, { recursive: true, force: true });
  }
}

test('password auth is the daemon default', () => {
  withHome(() => assert.equal(loadDaemonConfig().authMode, 'password'));
});

test('sso auth mode is accepted from the environment and needs no loopback bind', () => {
  withHome(() => {
    process.env.COMPANION_AUTH_MODE = 'sso';
    process.env.COMPANION_HOST = '0.0.0.0';
    assert.equal(loadDaemonConfig().authMode, 'sso');
    process.env.COMPANION_AUTH_MODE = 'nonsense';
    assert.throws(() => loadDaemonConfig(), /expected local, password or sso/);
  });
});

test('trusted local auth accepts loopback and rejects a network bind', () => {
  withHome((home) => {
    writeFileSync(join(home, 'companiond.json'), JSON.stringify({ authMode: 'local', host: '127.0.0.1' }));
    assert.equal(loadDaemonConfig().authMode, 'local');
    process.env.COMPANION_HOST = '0.0.0.0';
    assert.throws(() => loadDaemonConfig(), /requires a loopback bind/);
  });
});

test('only explicit loopback bind names qualify', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(isLoopbackHost('192.168.1.10'), false);
});

test('local HTTP admission rejects DNS rebinding and cross-site browser requests', () => {
  assert.equal(isTrustedLocalHttpRequest({ host: '127.0.0.1:8901' }), true);
  assert.equal(
    isTrustedLocalHttpRequest({
      host: 'localhost:8901',
      origin: 'http://localhost:5173',
      secFetchSite: 'same-site',
    }),
    true,
  );
  assert.equal(
    isTrustedLocalHttpRequest({ host: '[::1]:8901', origin: 'http://[::1]:8901', secFetchSite: 'same-origin' }),
    true,
  );
  assert.equal(isTrustedLocalHttpRequest({ host: 'rebind.example:8901', origin: 'https://rebind.example' }), false);
  assert.equal(isTrustedLocalHttpRequest({ host: 'localhost:8901', origin: 'https://evil.example' }), false);
  assert.equal(
    isTrustedLocalHttpRequest({
      host: 'localhost:8901',
      origin: 'http://localhost:8901',
      secFetchSite: 'cross-site',
    }),
    false,
  );
  assert.equal(isTrustedLocalHttpRequest({ host: 'localhost:8901', origin: 'null' }), false);
  assert.equal(isTrustedLocalHttpRequest({}), false);
});
