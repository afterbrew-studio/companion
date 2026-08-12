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
  scrubSeedPasswordEnvironment,
  setupExists,
  writePendingAdminSetup,
  writeStoredAuthMode,
} from '../dist/setup.js';
import { parseGhLogin, pendingGhLogin, resolveGithubHost, scheduleGhImport } from '../dist/github.js';

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

test('a detached hand-off can scrub every seed password from the CLI environment', () => {
  process.env.COMPANION_ADMIN_PASSWORD = 'admin-seed';
  process.env.COMPANION_MAINTAINER_PASSWORD = 'maintainer-seed';
  process.env.COMPANION_BUSINESS_PASSWORD = 'business-seed';

  scrubSeedPasswordEnvironment();

  assert.equal(process.env.COMPANION_ADMIN_PASSWORD, undefined);
  assert.equal(process.env.COMPANION_MAINTAINER_PASSWORD, undefined);
  assert.equal(process.env.COMPANION_BUSINESS_PASSWORD, undefined);
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
    parseGhLogin(
      JSON.stringify({ hosts: { 'github.com': [{ active: true, state: 'success', login: 'octocat' }] } }),
      'github.com',
    ),
    'octocat',
  );
  assert.equal(
    parseGhLogin(JSON.stringify({ hosts: { 'github.com': [{ active: false, login: 'octocat' }] } }), 'github.com'),
    null,
  );
  assert.equal(parseGhLogin('not-json', 'github.com'), null);
});

test('active gh login parser reads the entry for a GHES host, not github.com', () => {
  const raw = JSON.stringify({
    hosts: {
      'github.com': [{ active: true, state: 'success', login: 'personal' }],
      'ghe.corp': [{ active: true, state: 'success', login: 'corp-octocat' }],
    },
  });
  assert.equal(parseGhLogin(raw, 'ghe.corp'), 'corp-octocat');
  assert.equal(parseGhLogin(raw, 'github.com'), 'personal');
  assert.equal(parseGhLogin(JSON.stringify({ hosts: { 'ghe.corp': [] } }), 'ghe.corp'), null);
});

test('the gh host resolves like the daemon: env, then stored config, then github.com', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'companion-cli-gh-host-'));
  const saved = { home: process.env.COMPANION_HOME, host: process.env.COMPANION_GITHUB_HOST };
  process.env.COMPANION_HOME = home;
  delete process.env.COMPANION_GITHUB_HOST;
  t.after(() => {
    if (saved.home === undefined) delete process.env.COMPANION_HOME;
    else process.env.COMPANION_HOME = saved.home;
    if (saved.host === undefined) delete process.env.COMPANION_GITHUB_HOST;
    else process.env.COMPANION_GITHUB_HOST = saved.host;
    rmSync(home, { recursive: true, force: true });
  });

  assert.equal(resolveGithubHost(), 'github.com');
  writeFileSync(join(home, 'companiond.json'), JSON.stringify({ githubHost: 'stored.ghe.corp' }));
  assert.equal(resolveGithubHost(), 'stored.ghe.corp');
  process.env.COMPANION_GITHUB_HOST = 'env.ghe.corp';
  assert.equal(resolveGithubHost(), 'env.ghe.corp');
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
