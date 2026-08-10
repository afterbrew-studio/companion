import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  applyPendingAdminSetup,
  consumePendingAdminSetup,
  createDefaultAdmin,
  readAdminSetup,
  readStoredAuthMode,
  renderSetupBox,
  setupExists,
  writePendingAdminSetup,
  writeStoredAuthMode,
} from '../dist/setup.js';
import { parseGhLogin, pendingGhLogin, scheduleGhImport } from '../dist/github.js';

const cli = fileURLToPath(new URL('../dist/index.js', import.meta.url));

test('generated defaults are held in a one-time owner-only bootstrap file', () => {
  const home = mkdtempSync(join(tmpdir(), 'companion-cli-'));
  try {
    const setup = createDefaultAdmin();
    const file = writePendingAdminSetup(home, setup);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(setupExists(home, {}), true);
    assert.deepEqual(readAdminSetup(home, {}), { ...setup, passwordSource: 'chosen' });
    assert.deepEqual(applyPendingAdminSetup(home), { ...setup, passwordSource: 'chosen' });
    assert.equal(process.env.COMPANION_ADMIN_USER, setup.username);
    consumePendingAdminSetup(home);
    assert.equal(readAdminSetup(home, {}), null);
  } finally {
    delete process.env.COMPANION_ADMIN_USER;
    delete process.env.COMPANION_ADMIN_EMAIL;
    delete process.env.COMPANION_ADMIN_PASSWORD;
    rmSync(home, { recursive: true, force: true });
  }
});

test('an explicit auth mode initializes npx without inventing an admin password', () => {
  const home = mkdtempSync(join(tmpdir(), 'companion-cli-mode-'));
  try {
    writeStoredAuthMode(home, 'local');
    assert.equal(readStoredAuthMode(home), 'local');
    assert.equal(setupExists(home, {}), true);
    assert.equal(readAdminSetup(home, {}), null);
    assert.equal(statSync(join(home, 'companiond.json')).mode & 0o777, 0o600);

    // Updating the mode preserves settings owned by the daemon/operator.
    const file = join(home, 'companiond.json');
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    stored.port = 9999;
    writeFileSync(file, JSON.stringify(stored));
    writeStoredAuthMode(home, 'password');
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { authMode: 'password', port: 9999 });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('an existing local home cannot be switched to password auth without a credential migration', () => {
  const home = mkdtempSync(join(tmpdir(), 'companion-cli-local-lockout-'));
  try {
    writeStoredAuthMode(home, 'local');
    const attempts = [
      { env: process.env, extraArgs: ['--with-auth'] },
      { env: { ...process.env, COMPANION_AUTH_MODE: 'password' }, extraArgs: [] },
    ];
    for (const { env, extraArgs } of attempts) {
      const args = [cli, 'init', '--home', home, '--yes', '--no-open'];
      args.push(...extraArgs);
      const result = spawnSync(process.execPath, args, { encoding: 'utf8', env });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /already uses trusted local mode/);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('gh bootstrap stores consent and expected identity without a token', () => {
  const home = mkdtempSync(join(tmpdir(), 'companion-cli-gh-'));
  try {
    scheduleGhImport(home, 'octocat');
    const raw = readFileSync(join(home, 'pending-gh-import.json'), 'utf8');
    assert.equal(pendingGhLogin(home), 'octocat');
    assert.match(raw, /octocat/);
    assert.doesNotMatch(raw, /token/i);
    assert.equal(statSync(join(home, 'pending-gh-import.json')).mode & 0o777, 0o600);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('active gh login parser fails closed on malformed or inactive metadata', () => {
  assert.equal(
    parseGhLogin(JSON.stringify({ hosts: { 'github.com': [{ active: true, state: 'success', login: 'octocat' }] } })),
    'octocat',
  );
  assert.equal(parseGhLogin(JSON.stringify({ hosts: { 'github.com': [{ active: false, login: 'octocat' }] } })), null);
  assert.equal(parseGhLogin('not-json'), null);
});

test('confirmation box exposes generated credentials but never a chosen password', () => {
  const box = (setup) => renderSetupBox(setup, '/tmp/companion', 'http://127.0.0.1:8901');

  // Shown once or it is lost.
  const generated = createDefaultAdmin();
  assert.match(box(generated), new RegExp(generated.password));

  // Theirs, so it is never echoed back.
  const chosen = { ...generated, password: 'chosen-secret', passwordSource: 'chosen' };
  assert.doesNotMatch(box(chosen), /chosen-secret/);
  assert.match(box(chosen), /chosen/);
});

test('a scripted authenticated install gets an unpredictable password', () => {
  const generated = createDefaultAdmin();
  assert.equal(generated.passwordSource, 'generated');
  assert.equal(generated.password.length >= 20, true);
  assert.equal(generated.username, 'admin');
});
