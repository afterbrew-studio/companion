import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { GitHubAccounts } from '../dist/api/github-accounts.js';

const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
  type: 'pkcs8',
  format: 'pem',
});

async function githubApp({ failMints = 0 } = {}) {
  let calls = 0;
  const server = createServer((req, res) => {
    if (req.method === 'GET') {
      // Identity: an app installation has no viewer, so the login comes from here.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ account: { login: 'acme-corp' } }));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(404).end('{}');
      return;
    }
    calls += 1;
    if (calls <= failMints) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'try later' }));
      return;
    }
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ token: `ghs_${calls}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    api: `http://127.0.0.1:${server.address().port}`,
    get calls() {
      return calls;
    },
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** Rows plus the two writes the refresh path performs, so both are observable. */
function fixture(rows) {
  const accounts = rows.map((r) => ({
    id: r.id,
    login: r.login,
    token: r.token,
    purposes: ['fetch', 'runs'],
    scope: 'all',
    workspaceIds: [],
    ownerId: 'alice',
    createdAt: 1,
    kind: r.kind ?? 'app',
    appId: r.appId ?? '123456',
    installationId: r.installationId ?? '777',
    privateKey: r.privateKey ?? PEM,
    tokenExpiresAt: r.tokenExpiresAt ?? null,
    tokenHealth: r.tokenHealth ?? null,
    tokenError: r.tokenError ?? null,
  }));
  const store = {
    githubAccounts: {
      list: () => accounts,
      binding: () => null,
      bindingsFor: () => ({}),
      setInstallationToken: (id, token, expiresAt) => {
        const row = accounts.find((a) => a.id === id);
        row.token = token;
        row.tokenExpiresAt = expiresAt;
        row.tokenHealth = 'ok';
        row.tokenError = null;
      },
      setTokenFailure: (id, error) => {
        const row = accounts.find((a) => a.id === id);
        row.tokenHealth = 'failing';
        row.tokenError = error;
      },
    },
    repos: { workspaceIds: () => [] },
  };
  return { accounts, store };
}

const MARGIN = 25 * 60_000;

test('a token near expiry is re-minted and the new one is what resolves', async (t) => {
  const gh = await githubApp();
  t.after(gh.close);
  const { accounts, store } = fixture([
    { id: 'gha-app', login: 'acme', token: 'ghs_old', tokenExpiresAt: Date.now() + 5 * 60_000 },
  ]);
  const registry = new GitHubAccounts(store, gh.api);

  assert.equal((await registry.refreshInstallationTokens(MARGIN)).refreshed, 1);
  assert.equal(accounts[0].token, 'ghs_1');
  assert.equal(
    registry.tokenFor('fetch', { username: 'alice' }),
    'ghs_1',
    'the resolver must hand out the refreshed token, not the one it cached before',
  );
});

test('a token with plenty of life left is left alone', async (t) => {
  const gh = await githubApp();
  t.after(gh.close);
  const { store } = fixture([
    { id: 'gha-app', login: 'acme', token: 'ghs_old', tokenExpiresAt: Date.now() + 50 * 60_000 },
  ]);

  assert.equal((await new GitHubAccounts(store, gh.api).refreshInstallationTokens(MARGIN)).refreshed, 0);
  assert.equal(gh.calls, 0, 'a needless mint every ten minutes is a rate-limit problem, not a no-op');
});

test('an already expired token is refreshed, which is the cold-start case', async (t) => {
  const gh = await githubApp();
  t.after(gh.close);
  const { accounts, store } = fixture([
    { id: 'gha-app', login: 'acme', token: 'ghs_dead', tokenExpiresAt: Date.now() - 60_000 },
  ]);

  assert.equal((await new GitHubAccounts(store, gh.api).refreshInstallationTokens(MARGIN)).refreshed, 1);
  assert.equal(accounts[0].token, 'ghs_1');
});

test('personal access tokens are never touched by the refresh', async (t) => {
  const gh = await githubApp();
  t.after(gh.close);
  const { accounts, store } = fixture([
    { id: 'gha-pat', login: 'alice', token: 'github_pat_x', kind: 'pat', tokenExpiresAt: null },
  ]);

  assert.equal((await new GitHubAccounts(store, gh.api).refreshInstallationTokens(MARGIN)).refreshed, 0);
  assert.equal(accounts[0].token, 'github_pat_x');
  assert.equal(gh.calls, 0);
});

test('one unreachable installation does not stop the others', async (t) => {
  const gh = await githubApp({ failMints: 1 });
  t.after(gh.close);
  const { accounts, store } = fixture([
    { id: 'gha-a', login: 'first', token: 'ghs_a', tokenExpiresAt: Date.now() + 60_000 },
    { id: 'gha-b', login: 'second', token: 'ghs_b', tokenExpiresAt: Date.now() + 60_000 },
  ]);
  const warnings = [];

  const result = await new GitHubAccounts(store, gh.api).refreshInstallationTokens(MARGIN, (m) => warnings.push(m));
  assert.equal(result.refreshed, 1);
  assert.equal(accounts[0].token, 'ghs_a', 'the failed one keeps its old token, which is still valid');
  assert.equal(accounts[1].token, 'ghs_2');
  assert.match(warnings[0], /first/, 'the warning must name the account an operator has to fix');
});

test('the margin exceeds the job interval, so one failed run still beats expiry', async (t) => {
  const gh = await githubApp({ failMints: 1 });
  t.after(gh.close);
  const { accounts, store } = fixture([
    // Fresh token: 60 minutes of life, refresh due at 25 minutes remaining.
    { id: 'gha-app', login: 'acme', token: 'ghs_old', tokenExpiresAt: Date.now() + 24 * 60_000 },
  ]);
  const registry = new GitHubAccounts(store, gh.api);

  assert.equal((await registry.refreshInstallationTokens(MARGIN)).refreshed, 0, 'the first run fails');
  assert.equal(accounts[0].token, 'ghs_old', 'still valid for another 24 minutes');
  // Ten minutes later, the next scheduled run succeeds, well before expiry.
  assert.equal((await registry.refreshInstallationTokens(MARGIN)).refreshed, 1);
  assert.equal(accounts[0].token, 'ghs_2');
});

test('the cached client is dropped on refresh, or every call keeps the dead token', async (t) => {
  const gh = await githubApp();
  t.after(gh.close);
  const { store } = fixture([
    { id: 'gha-app', login: 'acme', token: 'ghs_old', tokenExpiresAt: Date.now() + 5 * 60_000 },
  ]);
  const registry = new GitHubAccounts(store, gh.api);
  // Resolving builds a client that closes over the token string.
  const before = registry.clientFor('fetch', { username: 'alice' });
  assert.ok(before);

  await registry.refreshInstallationTokens(MARGIN);

  const after = registry.clientFor('fetch', { username: 'alice' });
  assert.notEqual(after, before, 'a client held over the refresh authenticates with the expired token');
});

test('reconnecting replaces the app credentials, not just the token', async (t) => {
  const gh = await githubApp();
  t.after(gh.close);
  const { accounts, store } = fixture([
    { id: 'gha-app', login: 'acme-corp', token: 'ghs_old', appId: '111', installationId: '777' },
  ]);
  store.githubAccounts.update = () => {};
  store.githubAccounts.setAppCredentials = (id, app) => {
    const row = accounts.find((a) => a.id === id);
    Object.assign(row, { appId: app.appId, installationId: app.installationId, privateKey: app.privateKey });
  };
  // The stub answers /app/installations/777 for identity.
  const registry = new GitHubAccounts(store, gh.api);

  await registry.addApp({ appId: '222', installationId: '777', privateKey: PEM }, ['fetch'], 'alice');

  assert.equal(accounts[0].appId, '222', 'a rotated app id must take effect, not be reported and dropped');
});

// ---------- credential health (the transition, not the state) ----------

test('an installation that starts failing is reported once, not on every tick', async (t) => {
  // The refresh runs every ten minutes. Reporting the STATE would post 144
  // times a day for one broken app, which is how an alert gets muted.
  const gh = await githubApp({ failMints: 99 });
  t.after(gh.close);
  const { accounts, store } = fixture([
    { id: 'gha-app', login: 'acme', token: 'ghs_old', tokenExpiresAt: Date.now() + 60_000 },
  ]);
  const registry = new GitHubAccounts(store, gh.api);

  const first = await registry.refreshInstallationTokens(MARGIN);
  assert.deepEqual(
    first.started.map((f) => f.login),
    ['acme'],
  );
  assert.equal(accounts[0].tokenHealth, 'failing');
  assert.match(accounts[0].tokenError, /try later/);

  const second = await registry.refreshInstallationTokens(MARGIN);
  assert.deepEqual(second.started, [], 'the same outage must not be announced twice');
});

test('a failing installation that comes back is reported as recovered', async (t) => {
  const gh = await githubApp({ failMints: 1 });
  t.after(gh.close);
  const { accounts, store } = fixture([
    { id: 'gha-app', login: 'acme', token: 'ghs_old', tokenExpiresAt: Date.now() + 60_000 },
  ]);
  const registry = new GitHubAccounts(store, gh.api);

  await registry.refreshInstallationTokens(MARGIN);
  const back = await registry.refreshInstallationTokens(MARGIN);

  assert.deepEqual(
    back.recovered.map((f) => f.login),
    ['acme'],
  );
  assert.equal(accounts[0].tokenHealth, 'ok');
  assert.equal(accounts[0].tokenError, null, 'a stale error next to a working token is a false alarm');
});

test('a healthy fleet announces nothing at all', async (t) => {
  const gh = await githubApp();
  t.after(gh.close);
  const { store } = fixture([
    { id: 'gha-app', login: 'acme', token: 'ghs_old', tokenExpiresAt: Date.now() + 60_000 },
  ]);

  const result = await new GitHubAccounts(store, gh.api).refreshInstallationTokens(MARGIN);
  assert.deepEqual(result.started, []);
  assert.deepEqual(result.recovered, [], 'a first successful refresh is not a recovery');
});

test('the recorded error never carries the private key or the token', async (t) => {
  const gh = await githubApp({ failMints: 99 });
  t.after(gh.close);
  const { accounts, store } = fixture([
    { id: 'gha-app', login: 'acme', token: 'ghs_secret_value', tokenExpiresAt: Date.now() + 60_000 },
  ]);

  await new GitHubAccounts(store, gh.api).refreshInstallationTokens(MARGIN);

  assert.doesNotMatch(accounts[0].tokenError, /ghs_secret_value/);
  assert.doesNotMatch(accounts[0].tokenError, /PRIVATE KEY/);
});
