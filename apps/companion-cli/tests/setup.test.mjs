import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyPendingAdminSetup,
  consumePendingAdminSetup,
  createDefaultAdmin,
  createDefaultLogin,
  DEFAULT_LOGIN,
  readAdminSetup,
  renderSetupBox,
  setupExists,
  writePendingAdminSetup,
} from '../dist/setup.js';
import { parseGhLogin, pendingGhLogin, scheduleGhImport } from '../dist/github.js';

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

test('confirmation box exposes credentials the operator has not already picked', () => {
  const box = (setup) => renderSetupBox(setup, '/tmp/companion', 'http://127.0.0.1:8901');

  // Shown once or it is lost.
  const generated = createDefaultAdmin();
  assert.match(box(generated), new RegExp(generated.password));

  // Shown because it is what the operator was just offered; hiding the answer
  // to the question they said yes to helps nobody.
  assert.match(box(createDefaultLogin()), new RegExp(DEFAULT_LOGIN.password));

  // Theirs, so it is never echoed back.
  const chosen = { ...generated, password: 'chosen-secret', passwordSource: 'chosen' };
  assert.doesNotMatch(box(chosen), /chosen-secret/);
  assert.match(box(chosen), /chosen/);
});

test('a scripted install never gets the default login', () => {
  // `-y` and a container both land on createDefaultAdmin, where nobody is
  // watching to decide. A well-known password there is a published login.
  const generated = createDefaultAdmin();
  assert.equal(generated.passwordSource, 'generated');
  assert.notEqual(generated.password, DEFAULT_LOGIN.password);
  assert.equal(generated.password.length >= 20, true);
  // Same identity either way; it is only the credential that differs.
  assert.equal(generated.username, DEFAULT_LOGIN.username);
});

test('the default login is one the daemon will actually accept', () => {
  // The API refuses anything under 8 characters, so an offer it would reject
  // would fail at the one moment nobody can retry it.
  assert.equal(DEFAULT_LOGIN.password.length >= 8, true);
  assert.equal(createDefaultLogin().passwordSource, 'default');
});
