import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  applyPendingAdminSetup,
  consumePendingAdminSetup,
  createDefaultAdmin,
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
    assert.deepEqual(readAdminSetup(home, {}), { ...setup, generatedPassword: false });
    assert.deepEqual(applyPendingAdminSetup(home), { ...setup, generatedPassword: false });
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

test('confirmation box exposes generated credentials only when needed', () => {
  const generated = createDefaultAdmin();
  const generatedBox = renderSetupBox(generated, '/tmp/companion', 'http://127.0.0.1:8901');
  assert.match(generatedBox, new RegExp(generated.password));

  const chosen = { ...generated, password: 'chosen-secret', generatedPassword: false };
  const chosenBox = renderSetupBox(chosen, '/tmp/companion', 'http://127.0.0.1:8901');
  assert.doesNotMatch(chosenBox, /chosen-secret/);
  assert.match(chosenBox, /chosen/);
});
