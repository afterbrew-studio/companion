import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseEnvFile } from '@companion/services';
import { createDefaultAdmin, readAdminSetup, renderSetupBox, setupExists, writeAdminSetup } from '../dist/setup.js';
import { parseGhLogin, pendingGhLogin, scheduleGhImport } from '../dist/github.js';

test('generated defaults round-trip through the daemon env parser', () => {
  const home = mkdtempSync(join(tmpdir(), 'companion-cli-'));
  try {
    writeFileSync(join(home, '.env'), 'COMPANION_PORT=9911\n', 'utf8');
    const setup = createDefaultAdmin();
    const file = writeAdminSetup(home, setup);
    const parsed = parseEnvFile(file);

    assert.equal(parsed.COMPANION_PORT, '9911');
    assert.equal(parsed.COMPANION_ADMIN_USER, setup.username);
    assert.equal(parsed.COMPANION_ADMIN_EMAIL, setup.email);
    assert.equal(parsed.COMPANION_ADMIN_PASSWORD, setup.password);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(setupExists(home, {}), true);
    assert.deepEqual(readAdminSetup(home, {}), { ...setup, generatedPassword: false });
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

test('confirmation box exposes generated credentials only when needed', () => {
  const generated = createDefaultAdmin();
  const generatedBox = renderSetupBox(generated, '/tmp/companion', 'http://127.0.0.1:8901');
  assert.match(generatedBox, new RegExp(generated.password));

  const chosen = { ...generated, password: 'chosen-secret', generatedPassword: false };
  const chosenBox = renderSetupBox(chosen, '/tmp/companion', 'http://127.0.0.1:8901');
  assert.doesNotMatch(chosenBox, /chosen-secret/);
  assert.match(chosenBox, /chosen/);
});
