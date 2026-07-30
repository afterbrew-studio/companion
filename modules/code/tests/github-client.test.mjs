import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { GitHubClient } from '../dist/api/github-client.js';

/** A GitHub that answers every GET with one canned refusal. */
async function refusing(status, headers) {
  const server = createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify({ message: 'refused' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    client: new GitHubClient('test-token', `http://127.0.0.1:${port}`),
    close: () => new Promise((r) => server.close(r)),
  };
}

async function refusal(status, headers = {}) {
  const { client, close } = await refusing(status, headers);
  try {
    return await client.get('/repos/acme/app/issues').then(
      () => null,
      (err) => err,
    );
  } finally {
    await close();
  }
}

// 403 is the one status GitHub overloads: "you may not read this" and "you have
// spent your budget" arrive identically, and only the headers tell them apart.
test('a rate-limited refusal is marked, whichever budget it spent', async () => {
  const primary = await refusal(403, { 'x-ratelimit-remaining': '0' });
  const secondary = await refusal(403, { 'retry-after': '60' });
  const explicit = await refusal(429, {});

  assert.equal(primary.rateLimited, true);
  assert.equal(secondary.rateLimited, true);
  assert.equal(explicit.rateLimited, true);
});

test('a plain refusal is not rate limited', async () => {
  const forbidden = await refusal(403, { 'x-ratelimit-remaining': '4999' });
  const missing = await refusal(404, {});

  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.rateLimited, false);
  assert.equal(missing.rateLimited, false);
});
