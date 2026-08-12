import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import routeFactory from '../dist/api/routes.js';

process.env.COMPANION_HOME = mkdtempSync(join(tmpdir(), 'companion-status-identity-'));

/**
 * GET /api/status is `access: 'any'`, so every role reads it. The health facts
 * are meant to be that open; the instance GitHub posting login is not, and it
 * is disclosed only to a viewer the account-owning module vouches for. Operate
 * owns neither the accounts nor the permission guarding them, so absent an
 * answer it must withhold rather than assume one.
 */

const business = { username: 'bea', displayName: 'Bea', role: 'business' };
const admin = { username: 'ada', displayName: 'Ada', role: 'admin' };

function fixture(tokenSource) {
  const op = {
    runners: { list: () => [] },
    runTaskDescriptors: () => [],
    githubTokens: () => ({ tokenFor: () => null, login: () => 'moxxy-bot', ...tokenSource }),
  };
  const routes = routeFactory({
    services: { get: (id) => (id === 'operate' ? op : {}) },
    rbac: { allows: () => true },
    modules: { list: () => [] },
  });
  const status = (user) => {
    const target = routes.find((c) => c.method === 'GET' && c.path === '/api/status');
    assert.ok(target, 'GET /api/status route exists');
    return target.run({}, new URLSearchParams(), {}, user, null, '127.0.0.1', false);
  };
  return { status };
}

test('a viewer the account module does not vouch for is not told the login', async () => {
  const { status } = fixture({ hasAccounts: () => true, canSeeLogin: (v) => v.role === 'admin' });

  const seen = await status(business);
  assert.equal(seen.githubUser, null);
  // The health fact itself stays open: withholding a name must not make the
  // instance look unconfigured to the roles that cannot read it.
  assert.equal(seen.githubConfigured, true);
});

test('a vouched-for viewer still gets the login', async () => {
  const { status } = fixture({ hasAccounts: () => true, canSeeLogin: (v) => v.role === 'admin' });
  assert.equal((await status(admin)).githubUser, 'moxxy-bot');
});

test('a token source that answers nothing withholds the login from everyone', async () => {
  // module-code disabled, or an older source: no rule means no disclosure.
  const { status } = fixture({ hasAccounts: () => true });

  assert.equal((await status(admin)).githubUser, null);
  assert.equal((await status(business)).githubUser, null);
  assert.equal((await status(admin)).githubConfigured, true);
});
