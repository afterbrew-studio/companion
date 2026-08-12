import assert from 'node:assert/strict';
import test from 'node:test';
import jobs from '../dist/api/jobs.js';

/**
 * module-code fills operate's GitHub token seam, and with it the rule deciding
 * who /api/status may name the instance posting account to. operate cannot make
 * that call itself: `github:connect` is code's permission and operate never
 * imports code. The leak this pins is a business profile reading the operator's
 * GitHub login off a route that is open to every role.
 */

function enableAndCaptureSource(allows) {
  let source = null;
  const code = {
    prReviews: { recoverInterrupted() {} },
    triage: { recoverInterrupted() {} },
    githubAccounts: {
      loginFor: () => 'moxxy-bot',
      list: () => [{ id: 'acct' }],
      tokenFor: () => null,
      verifiedTokenFor: () => null,
    },
  };
  const operate = {
    setGithubTokenSource: (s) => void (source = s),
    setVerifyCommandResolver() {},
    setWorkspaceForRepo() {},
    orchestrator: { registerResumer() {} },
  };
  jobs.onEnable({
    services: {
      get: (id) => ({ code, operate, integrations: { registerProvider: () => () => {} } })[id],
    },
    ws: { registerScopeResolver() {} },
    bus: { on: () => () => {} },
    rbac: { allows },
    log: { info() {}, warn() {}, error() {}, debug() {} },
  });
  assert.ok(source, 'onEnable plugs a token source into operate');
  return source;
}

test('only a github:connect holder is vouched for', () => {
  const seen = [];
  const source = enableAndCaptureSource((user, permission) => {
    seen.push(permission);
    return user.role === 'admin';
  });

  assert.equal(source.canSeeLogin({ username: 'ada', role: 'admin' }), true);
  assert.equal(source.canSeeLogin({ username: 'bea', role: 'business' }), false);
  // Pinned by name: a rule that asked for some other permission would grant a
  // different set of roles than the GitHub accounts page it mirrors.
  assert.deepEqual([...new Set(seen)], ['github:connect']);
});

test('the login itself is still reported to the seam', () => {
  const source = enableAndCaptureSource(() => true);
  assert.equal(source.login(), 'moxxy-bot');
  assert.equal(source.hasAccounts(), true);
});
