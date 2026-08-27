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

test('read-only queue calls expose bounded rate telemetry and explicit open-state URLs', async () => {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, {
      'content-type': 'application/json',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '4321',
      'x-ratelimit-reset': '1800000000',
      'x-ratelimit-resource': 'core',
    });
    res.end('[]');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const client = new GitHubClient('test-token', `http://127.0.0.1:${port}`);
  try {
    await client.pulls('acme/app', 1, 'open');
    await client.issues('acme/app', { maxPages: 1, state: 'open' });
    assert.deepEqual(seen, [
      '/repos/acme/app/pulls?state=open&per_page=100&sort=updated&direction=desc&page=1',
      '/repos/acme/app/issues?state=open&per_page=100&sort=updated&direction=desc&page=1',
    ]);
    assert.deepEqual(client.rateLimitSnapshot(), {
      limit: 5000,
      remaining: 4321,
      resetAt: 1_800_000_000_000,
      resource: 'core',
      observedAt: client.rateLimitSnapshot().observedAt,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('autonomy queue uses body-free GraphQL metadata instead of one REST detail call per PR', async () => {
  const requests = [];
  const writes = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ method: req.method, url: req.url, query: body.query, variables: body.variables });
    const isPulls = body.query.includes('CompanionAutonomyPulls');
    res.writeHead(200, { 'content-type': 'application/json', 'x-ratelimit-remaining': '4990' });
    res.end(JSON.stringify({
      data: {
        repository: isPulls
          ? {
              pullRequests: {
                totalCount: 1,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{
                  number: 7,
                  title: 'Large contribution',
                  url: 'https://github.test/acme/app/pull/7',
                  createdAt: '2026-08-02T00:00:00Z',
                  updatedAt: '2026-08-02T01:00:00Z',
                  isDraft: false,
                  additions: 900,
                  deletions: 200,
                  changedFiles: 51,
                  mergeable: 'CONFLICTING',
                  mergeStateStatus: 'DIRTY',
                  headRefName: 'feature',
                  headRefOid: 'abc123',
                  baseRefName: 'main',
                  reviewDecision: 'CHANGES_REQUESTED',
                  author: { login: 'contributor' },
                  labels: { nodes: [{ name: 'agent-authored' }] },
                }],
              },
            }
          : {
              issues: {
                totalCount: 1,
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{
                  number: 9,
                  title: 'Bug report',
                  url: 'https://github.test/acme/app/issues/9',
                  createdAt: '2026-08-02T00:00:00Z',
                  updatedAt: '2026-08-02T01:00:00Z',
                  author: { login: 'reporter' },
                  comments: { totalCount: 2 },
                  labels: { totalCount: 0 },
                  assignees: { totalCount: 0 },
                }],
              },
            },
      },
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const client = new GitHubClient('test-token', `http://127.0.0.1:${port}`, (what) => writes.push(what));
  try {
    const queue = await client.repositoryAutonomyQueue('acme/app');
    assert.equal(requests.length, 2);
    assert.ok(requests.every((request) => request.method === 'POST' && request.url === '/graphql'));
    assert.equal(writes.length, 0, 'a constant GraphQL query is not a forge mutation');
    assert.deepEqual(
      {
        pullCount: queue.openPullCount,
        issueCount: queue.openIssueCount,
        lines: queue.pulls[0].additions + queue.pulls[0].deletions,
        files: queue.pulls[0].changed_files,
        mergeable: queue.pulls[0].mergeable,
        review: queue.pulls[0].review_decision,
        body: queue.pulls[0].body,
      },
      {
        pullCount: 1,
        issueCount: 1,
        lines: 1100,
        files: 51,
        mergeable: false,
        review: 'changes_requested',
        body: null,
      },
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('repository agent context batches text files into one read-only GraphQL request', async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ method: req.method, url: req.url, body: JSON.parse(raw) });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      data: {
        repository: {
          f0: { text: '# Rules', isBinary: false, byteSize: 7 },
          f1: { text: '## Summary', isBinary: false, byteSize: 10 },
        },
      },
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const client = new GitHubClient('test-token', `http://127.0.0.1:${port}`);
  try {
    const files = await client.repoTextFiles(
      'acme/app',
      'main',
      ['AGENTS.md', '.github/pull_request_template.md'],
    );

    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].url, '/graphql');
    assert.match(requests[0].body.query, /CompanionRepositoryAgentContext/);
    assert.doesNotMatch(requests[0].body.query, /AGENTS\.md/);
    assert.deepEqual(requests[0].body.variables, {
      owner: 'acme',
      name: 'app',
      expression0: 'main:AGENTS.md',
      expression1: 'main:.github/pull_request_template.md',
    });
    assert.equal(files.get('AGENTS.md'), '# Rules');
    assert.equal(files.get('.github/pull_request_template.md'), '## Summary');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('merge enters the instance write-policy choke point before network I/O', async () => {
  let requests = 0;
  const server = createServer((_req, res) => {
    requests += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ merged: true, message: 'merged' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const client = new GitHubClient('test-token', `http://127.0.0.1:${port}`, (what) => {
    throw new Error(`write refused: ${what}`);
  });
  try {
    await assert.rejects(
      client.mergePr('acme/app', 7, 'squash', 'abc123'),
      /write refused: PUT \/repos\/acme\/app\/pulls\/7\/merge/,
    );
    assert.equal(requests, 0, 'policy refusal happens before contacting GitHub');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
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

test('managed repository webhooks install once, reconcile, and delete idempotently', async () => {
  const requests = [];
  let installed = false;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });

    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(installed ? [{ id: 42, name: 'web', active: true, config: { url: 'https://hooks.test/x' } }] : []));
      return;
    }
    if (req.method === 'POST') installed = true;
    if (req.method === 'DELETE') {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 42, name: 'web', active: true, config: { url: 'https://hooks.test/x' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const writes = [];
  const client = new GitHubClient('test-token', `http://127.0.0.1:${port}`, (what) => writes.push(what));
  try {
    assert.equal(await client.ensureRepoWebhook('acme/app', 'https://hooks.test/x', 'secret-one'), 42);
    assert.equal(await client.ensureRepoWebhook('acme/app', 'https://hooks.test/x', 'secret-two', 42), 42);
    await client.deleteRepoWebhook('acme/app', 42);

    assert.deepEqual(requests.map(({ method, url }) => `${method} ${url}`), [
      'GET /repos/acme/app/hooks?per_page=100&page=1',
      'POST /repos/acme/app/hooks',
      'PATCH /repos/acme/app/hooks/42',
      'DELETE /repos/acme/app/hooks/42',
    ]);
    // `pull_request_review` is the submission of a review, which is what moves a
    // pull request's review decision. Subscribing only to
    // `pull_request_review_comment` sees individual inline comments and misses a
    // summary-only review entirely, so the cached decision never updates.
    assert.deepEqual(requests[1].body.events, [
      'issues',
      'pull_request',
      'pull_request_review',
      'pull_request_review_comment',
      'check_run',
      'check_suite',
      'status',
    ]);
    assert.equal(requests[1].body.config.content_type, 'json');
    assert.equal(requests[2].body.config.secret, 'secret-two');
    assert.deepEqual(writes.map((what) => what.split(' ')[0]), ['POST', 'PATCH', 'DELETE']);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('review-thread reads and reviewed mutations use the exact GitHub endpoints and payloads', async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ method: req.method, url: req.url, body });
    if (req.url === '/graphql' && body?.query.includes('query ReviewThreads')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [{
          id: 'PRRT_1', isResolved: false, isOutdated: false, path: 'src/a.ts', line: 8,
          comments: { nodes: [{
            id: 'PRRC_1', databaseId: 501, author: { login: 'sara' }, body: 'Please guard this.',
            createdAt: '2026-08-19T10:00:00Z', url: 'https://github.test/c/501', path: 'src/a.ts',
            line: 8, originalLine: 8, replyTo: null,
          }] },
        }],
      } } } } }));
      return;
    }
    if (req.url === '/graphql') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { resolveReviewThread: { thread: { id: 'PRRT_1', isResolved: true } } } }));
      return;
    }
    if (req.method === 'DELETE') {
      res.writeHead(204);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 900, html_url: 'https://github.test/c/900' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const writes = [];
  const client = new GitHubClient('test-token', `http://127.0.0.1:${port}`, (what) => writes.push(what));
  try {
    const read = await client.prReviewThreads('acme/app', 7);
    assert.equal(read.threads[0].comments.nodes[0].databaseId, 501);
    await client.replyToReviewComment('acme/app', 7, 501, 'Handled in the current patch.');
    await client.createReviewComment('acme/app', 7, {
      commit_id: 'abc123', path: 'src/a.ts', body: 'Use the validated value.', line: 8, side: 'RIGHT',
    });
    await client.resolveReviewThread('PRRT_1');
    await client.removeLabel('acme/app', 7, 'needs review');
    await client.removeAssignees('acme/app', 11, ['james']);
    await client.removeReviewers('acme/app', 7, ['sara']);
    await client.closePr('acme/app', 7);
    await client.reopenPr('acme/app', 7);

    assert.deepEqual(requests.map((request) => `${request.method} ${request.url}`), [
      'POST /graphql',
      'POST /repos/acme/app/pulls/7/comments/501/replies',
      'POST /repos/acme/app/pulls/7/comments',
      'POST /graphql',
      'DELETE /repos/acme/app/issues/7/labels/needs%20review',
      'DELETE /repos/acme/app/issues/11/assignees',
      'DELETE /repos/acme/app/pulls/7/requested_reviewers',
      'PATCH /repos/acme/app/pulls/7',
      'PATCH /repos/acme/app/pulls/7',
    ]);
    assert.deepEqual(requests[1].body, { body: 'Handled in the current patch.' });
    assert.equal(requests[2].body.commit_id, 'abc123');
    assert.deepEqual(requests[5].body, { assignees: ['james'] });
    assert.deepEqual(requests[6].body, { reviewers: ['sara'] });
    assert.deepEqual(requests[7].body, { state: 'closed' });
    assert.deepEqual(requests[8].body, { state: 'open' });
    assert.equal(writes.length, 8, 'the GraphQL thread read stays outside the write-policy gate');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

function ghFile(filename) {
  return { filename, status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-old\n+new' };
}
