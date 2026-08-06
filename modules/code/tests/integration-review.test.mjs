import assert from 'node:assert/strict';
import test from 'node:test';
import { PrReviews, integrationReviewOutcome } from '../dist/api/pr-reviews.js';

const placeholder = Object.freeze({
  id: 'prr-external',
  repo: 'acme/app',
  prNumber: 7,
  runId: null,
  runIds: [],
  source: 'agent',
  providerId: 'vendor.review',
  reviewMode: 'managed',
  externalUrl: null,
  externalSummary: null,
  status: 'running',
  verdict: null,
  error: null,
  progress: { phase: 'reviewing', completed: 0, total: 1, message: 'running', updatedAt: 1 },
  coverage: {
    state: 'unavailable',
    reviewedGroups: 0,
    totalGroups: 0,
    reviewedFiles: 0,
    totalFiles: 0,
    unread: [],
  },
  createdAt: 1,
  headSha: 'head-7',
  depth: 'in-depth',
  strictness: 'balanced',
  findings: [],
});

test('a skipped vendor review can never become an approval verdict', () => {
  const result = integrationReviewOutcome(
    placeholder,
    { kind: 'skipped', summary: 'Provider skipped unsupported changes' },
    'balanced',
  );

  assert.equal(result.status, 'failed');
  assert.equal(result.verdict, null);
  assert.equal(result.coverage.state, 'unavailable');
  assert.match(result.error, /skipped unsupported changes/);
});

test('external findings below the selected strictness do not become a request-changes verdict', () => {
  const result = integrationReviewOutcome(
    placeholder,
    {
      kind: 'draft',
      summary: 'One advisory finding',
      reviewBody: 'A major improvement was reported.',
      coverage: 'complete',
      findings: [{
        severity: 'major',
        title: 'Advisory finding',
        file: 'src/app.ts',
        line: 7,
        reason: 'The provider considers this worth changing.',
        impact: 'Maintainability.',
        suggestion: 'Refactor this path.',
        confidence: 0.8,
      }],
    },
    'blockers-only',
  );

  assert.equal(result.status, 'pending');
  assert.equal(result.verdict?.recommendation, 'comment');
  assert.equal(result.verdict?.risk, 'low');
  assert.deepEqual(result.verdict?.findings, []);
  assert.equal(result.findings[0]?.state, 'proposed');
});

test('a delegated reviewer requires PR write authority because its trigger is a comment', () => {
  const target = {
    ref: { providerId: 'cursor.bugbot', connectionId: 'cursor' },
    provider: {
      descriptor: {
        id: 'cursor.bugbot',
        moduleId: 'cursor-bugbot',
        vendor: 'Cursor',
        title: 'Cursor Bugbot',
        description: 'Delegated review',
        category: 'review',
        capabilities: ['code-review'],
        scopes: ['workspace'],
        connectionMode: 'required',
        execution: 'delegated',
        fields: [],
      },
      review: async () => ({ kind: 'delegated', summary: 'requested', externalUrl: null }),
    },
    connection: { record: { id: 'cursor' }, secret: () => null },
  };
  const reviews = new PrReviews(
    {
      prs: { get: () => ({ state: 'open', draft: false, headSha: 'head-7' }) },
      prReviews: { running: () => null },
    },
    {},
    {},
    () => null,
    () => 1_000,
    () => null,
    async () => ({ result: null, client: null, tried: [] }),
    {},
    (_user, permission) => permission !== 'prs:act',
    () => undefined,
    { resolveTargets: () => [target] },
    () => ({ kind: 'workspace', workspaceId: 'ws-1' }),
  );

  assert.throws(
    () => reviews.validateAnalyze('acme/app', 7, 'alice'),
    /cannot use Cursor Bugbot/,
  );
});

test('an unavailable native checkout advances to the configured review fallback', async () => {
  const rows = new Map();
  const order = [];
  const store = {
    prs: {
      get: () => ({
        state: 'open',
        draft: false,
        headSha: 'head-7',
        baseRef: 'main',
        title: 'Use the routed reviewer',
        body: '',
        author: 'alice',
      }),
    },
    prReviews: {
      running: () => null,
      insert: (row) => {
        rows.set(row.id, row);
        order.push(row.id);
      },
      get: (id) => rows.get(id),
      finish: (row) => {
        rows.set(row.id, row);
        return true;
      },
      latest: () => rows.get(order.at(-1)) ?? null,
      setProgress: (id, progress, coverage) => {
        const current = rows.get(id);
        if (current) rows.set(id, { ...current, progress, ...(coverage ? { coverage } : {}) });
      },
      setBudgetEvidence: () => undefined,
    },
    prReviewFindings: {
      listForReview: () => [],
      insertMissing: () => undefined,
    },
  };
  const native = {
    ref: { providerId: 'companion.native-review', connectionId: null },
    provider: {
      descriptor: {
        id: 'companion.native-review',
        title: 'Companion AI review',
        execution: 'local',
      },
    },
    connection: null,
  };
  const fallback = {
    ref: { providerId: 'vendor.review', connectionId: 'vendor-1' },
    provider: {
      descriptor: {
        id: 'vendor.review',
        title: 'Vendor review',
        execution: 'remote',
      },
    },
    connection: { record: { id: 'vendor-1' }, secret: () => null },
  };
  let executed = 0;
  const reviews = new PrReviews(
    store,
    {},
    { hasClone: () => false },
    () => null,
    () => 1_000_000,
    () => null,
    async () => ({ result: null, client: null, tried: [] }),
    {},
    () => true,
    () => undefined,
    {
      resolveTargets: () => [native, fallback],
      executeReview: async () => {
        executed++;
        return {
          kind: 'draft',
          summary: 'Fallback completed',
          reviewBody: 'No issues found.',
          findings: [],
          coverage: 'complete',
        };
      },
    },
    () => ({ kind: 'repository', workspaceId: 'ws-1', repo: 'acme/app' }),
  );

  const result = await reviews.analyzePr('acme/app', 7, 'alice');

  assert.equal(executed, 1);
  assert.equal(order.length, 2);
  assert.equal(rows.get(order[0]).status, 'failed');
  assert.match(rows.get(order[0]).error, /no local clone/);
  assert.equal(result.providerId, 'vendor.review');
  assert.equal(result.status, 'pending');
});

test('a posting pipeline rejects delegated review before the provider can write to GitHub', async () => {
  let executed = 0;
  const delegated = {
    ref: { providerId: 'cursor.bugbot', connectionId: 'cursor' },
    provider: {
      descriptor: {
        id: 'cursor.bugbot',
        title: 'Cursor Bugbot',
        execution: 'delegated',
      },
    },
    connection: { record: { id: 'cursor' }, secret: () => null },
  };
  const reviews = new PrReviews(
    { prs: { get: () => ({ state: 'open', draft: false }) }, prReviews: { running: () => null } },
    {},
    {},
    () => null,
    () => 1_000_000,
    () => null,
    async () => ({ result: null, client: null, tried: [] }),
    {},
    () => true,
    () => undefined,
    {
      resolveTargets: () => [delegated],
      executeReview: async () => {
        executed++;
        return { kind: 'delegated', summary: 'requested', externalUrl: null };
      },
    },
    () => ({ kind: 'repository', workspaceId: 'ws-1', repo: 'acme/app' }),
  );

  await assert.rejects(
    reviews.analyzePr('acme/app', 7, 'alice', undefined, { progressivePost: {} }),
    /owns its GitHub publication/,
  );
  assert.equal(executed, 0);
});
