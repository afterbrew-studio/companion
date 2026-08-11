import assert from 'node:assert/strict';
import test from 'node:test';
import jobs from '../dist/api/jobs.js';

/**
 * Credential-outage notifications deep-link the GitHub accounts page. The
 * client route is `prefix: '/github'` (src/client/routes.tsx); a wrong hash
 * here 404s exactly when an admin most needs the page.
 */

function contextReporting(result, emitted) {
  return {
    services: {
      get: () => ({ githubAccounts: { refreshInstallationTokens: async () => result } }),
    },
    notify: { emit: (n) => emitted.push(n) },
    log: { info: () => {}, warn: () => {} },
  };
}

test('outage and recovery notifications link #/github', async () => {
  const emitted = [];
  await jobs.postActivate(
    contextReporting(
      {
        refreshed: 0,
        started: [{ login: 'acme-corp', error: 'key rejected' }],
        recovered: [{ login: 'other-org' }],
      },
      emitted,
    ),
  );
  assert.equal(emitted.length, 2);
  for (const notification of emitted) assert.equal(notification.href, '#/github');
});
