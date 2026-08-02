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

test('an upstream credential rejection cannot masquerade as an expired Companion session', async () => {
  const unauthorized = await refusal(401, {});

  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.clientStatus, 502);
});

test('a changed-file page follows GitHub Link navigation instead of guessing from its length', async () => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    const page = new URL(req.url, 'http://localhost').searchParams.get('page');
    const files = page === '1' ? [ghFile('one.ts'), ghFile('two.ts')] : [ghFile('three.ts')];
    res.writeHead(200, {
      'content-type': 'application/json',
      ...(page === '1'
        ? { link: '<https://api.github.test/repos/acme/app/pulls/7/files?per_page=2&page=2>; rel="next"' }
        : {}),
    });
    res.end(JSON.stringify(files));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const client = new GitHubClient('test-token', `http://127.0.0.1:${port}`);
  try {
    const first = await client.prFilesPage('acme/app', 7, 1, 2);
    const second = await client.prFilesPage('acme/app', 7, 2, 2);

    assert.deepEqual(seen, [
      '/repos/acme/app/pulls/7/files?per_page=2&page=1',
      '/repos/acme/app/pulls/7/files?per_page=2&page=2',
    ]);
    assert.equal(first.hasNextPage, true);
    assert.equal(second.hasNextPage, false);
    assert.equal(second.files[0].filename, 'three.ts');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a full changed-file page with only a previous Link is terminal', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      'content-type': 'application/json',
      link: '<https://api.github.test/repos/acme/app/pulls/7/files?per_page=2&page=1>; rel="prev"',
    });
    res.end(JSON.stringify([ghFile('one.ts'), ghFile('two.ts')]));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const client = new GitHubClient('test-token', `http://127.0.0.1:${port}`);
  try {
    const page = await client.prFilesPage('acme/app', 7, 2, 2);
    assert.equal(page.hasNextPage, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('aggregate review file loading remains complete across pages and reports a real cap', async () => {
  const server = createServer((req, res) => {
    const page = Number(new URL(req.url, 'http://localhost').searchParams.get('page'));
    const files = Array.from({ length: 100 }, (_, index) => ghFile(`page-${page}-${index}.ts`));
    res.writeHead(200, {
      'content-type': 'application/json',
      link: `<https://api.github.test/repos/acme/app/pulls/7/files?per_page=100&page=${page + 1}>; rel="next"`,
    });
    res.end(JSON.stringify(files));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const client = new GitHubClient('test-token', `http://127.0.0.1:${port}`);
  try {
    const result = await client.prFiles('acme/app', 7, 2);
    assert.equal(result.files.length, 200);
    assert.equal(result.truncated, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('changed-file page bounds reject accidental unbounded requests before network I/O', async () => {
  const client = new GitHubClient('test-token', 'http://127.0.0.1:1');

  await assert.rejects(() => client.prFilesPage('acme/app', 7, 0), /positive integer/);
  await assert.rejects(() => client.prFilesPage('acme/app', 7, 1, 101), /between 1 and 100/);
});

function ghFile(filename) {
  return { filename, status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' };
}
