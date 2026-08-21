import assert from 'node:assert/strict';
import test from 'node:test';
import { RemoteRunnerBackend } from '../dist/api/remote-backend.js';

const sink = {
  onEvent() {},
  onTurnComplete() {},
  onAsk() {},
  onAskResolved() {},
  onGone() {},
  onRunnerUnreachable() {},
  onRunnerReachable() {},
};

/** Capture every fetch the backend makes; no real network is involved. */
function captureFetch() {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify({ ok: true, cwd: '/work' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

function backend(endpoint, resolved) {
  return new RemoteRunnerBackend('r1', endpoint, 'bearer-secret', sink, async (repo, username, access) => {
    resolved.push(access ?? 'read');
    return 'gh-secret';
  });
}

test('the GitHub credential never rides a plain-http runner endpoint', async () => {
  const { calls, restore } = captureFetch();
  const resolved = [];
  const remote = backend('http://127.0.0.1:1', resolved);
  try {
    await remote.ensureClone('o/r', 'alice');
    await remote.addWorktree('o/r', 'k', 'feature', 'main', 'alice');
    await remote.push('o/r', '/work', 'feature', 'alice');
  } finally {
    remote.dispose();
    restore();
  }
  // Authorisation still runs on the daemon; only the wire is denied the token.
  assert.deepEqual(resolved, ['read', 'read', 'write']);
  assert.equal(calls.length, 3);
  for (const call of calls) assert.equal('githubToken' in call.body, false);
  assert.equal(JSON.stringify(calls).includes('gh-secret'), false);
});

test('the GitHub credential rides an https runner endpoint per call', async () => {
  const { calls, restore } = captureFetch();
  const remote = backend('https://127.0.0.1:1', []);
  try {
    await remote.ensureClone('o/r', 'alice');
    await remote.push('o/r', '/work', 'feature', 'alice');
  } finally {
    remote.dispose();
    restore();
  }
  assert.equal(calls.length, 2);
  for (const call of calls) assert.equal(call.body.githubToken, 'gh-secret');
});
