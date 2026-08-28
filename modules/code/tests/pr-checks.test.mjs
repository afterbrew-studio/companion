import assert from 'node:assert/strict';
import test from 'node:test';
import { PrChecks, UnknownPrError, latestPerName } from '../dist/api/pr-checks.js';

function openPr(number) {
  return {
    repo: 'moxxy-ai/companion',
    number,
    state: 'open',
    headSha: `sha${number}`,
    checks: null,
    reviewDecision: null,
    mergeable: null,
    mergeStateStatus: null,
  };
}

/** Captures what the module logs, so "quietly" is an assertion and not a hope. */
function recordWarnings(run) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  return Promise.resolve()
    .then(run)
    .finally(() => {
      console.warn = original;
    })
    .then(() => warnings);
}

function storeOf(rows) {
  return {
    prs: {
      list: () => [...rows.values()],
      get: (_repo, number) => rows.get(number),
      setChecks() {},
      setMergeable() {},
      setReviewDecision() {},
    },
  };
}

test('a PR that leaves the cache mid-refresh is skipped without a warning', async () => {
  const rows = new Map([26, 27, 28].map((n) => [n, openPr(n)]));
  const client = {
    // Disconnecting the repo drops every one of its PR rows; the refresh loop
    // is already holding the list it read before that happened.
    checkRuns: async () => {
      rows.clear();
      return [];
    },
    combinedStatus: async () => null,
    pull: async () => ({}),
    prReviewList: async () => ({ reviews: [], truncated: false }),
  };
  const checks = new PrChecks(storeOf(rows), () => client, () => undefined);

  const warnings = await recordWarnings(() => checks.refreshOpenPrs('moxxy-ai/companion', 'maintainer'));

  assert.deepEqual(warnings, []);
});

test('a genuine checks fetch failure is still reported', async () => {
  const rows = new Map([[26, openPr(26)]]);
  const checks = new PrChecks(
    storeOf(rows),
    () => {
      throw new Error('no usable GitHub account');
    },
    () => undefined,
  );

  const warnings = await recordWarnings(() => checks.refreshOpenPrs('moxxy-ai/companion', 'maintainer'));

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /checks fetch failed/);
});

test('a caller that named the PR itself still gets an error', async () => {
  const checks = new PrChecks(storeOf(new Map()), () => null, () => undefined);

  await assert.rejects(
    () => checks.fetchSummary('moxxy-ai/companion', 30, 'maintainer'),
    (err) => err instanceof UnknownPrError && /unknown PR moxxy-ai\/companion#30/.test(err.message),
  );
});

/** storeOf, but setChecks is observable: caching is the thing under test here. */
function recordingStore(rows) {
  const cached = [];
  return {
    cached,
    prs: {
      list: () => [...rows.values()],
      get: (_repo, number) => rows.get(number),
      setChecks: (repo, number, snapshot) => {
        cached.push({ repo, number, snapshot });
        const row = rows.get(number);
        if (row) rows.set(number, { ...row, checks: snapshot });
      },
      setMergeable: (_repo, number, mergeable, mergeStateStatus = null) => {
        const row = rows.get(number);
        if (row) rows.set(number, { ...row, mergeable, mergeStateStatus });
      },
      setReviewDecision: (_repo, number, reviewDecision) => {
        const row = rows.get(number);
        if (row) rows.set(number, { ...row, reviewDecision });
      },
    },
  };
}

test('with no GitHub client the answer is unknown, and it is not cached', async () => {
  const rows = new Map([[26, { ...openPr(26), state: 'merged' }]]);
  const store = recordingStore(rows);
  const checks = new PrChecks(store, () => null, () => undefined);

  const summary = await checks.fetchSummary('moxxy-ai/companion', 26, 'maintainer');

  // 'none' reads as "no CI configured", which merge gates treat as green, and
  // a revoked token must never look like a clean build.
  assert.equal(summary.state, 'unknown');
  // Caching it would freeze that verdict past the credential coming back.
  assert.deepEqual(store.cached, []);
});

test('a settled PR with no head commit caches its empty snapshot', async () => {
  const rows = new Map([[26, { ...openPr(26), state: 'merged', headSha: null }]]);
  const store = recordingStore(rows);
  const client = {
    checkRuns: async () => [],
    combinedStatus: async () => null,
    pull: async () => ({}),
    prReviewList: async () => ({ reviews: [], truncated: false }),
  };
  const broadcasts = [];
  const checks = new PrChecks(store, () => client, (msg) => broadcasts.push(msg));

  const summary = await checks.fetchSummary('moxxy-ai/companion', 26, 'maintainer');

  assert.equal(summary.state, 'none');
  // The preload queue selects settled PRs with no snapshot, so leaving this
  // uncached re-queues the same PR on every pass, forever.
  assert.equal(store.cached.length, 1);
  assert.equal(store.cached[0].snapshot.state, 'none');
  assert.equal(broadcasts.length, 1);
  assert.deepEqual(broadcasts[0], {
    t: 'prStatus.changed',
    repo: 'moxxy-ai/companion',
    number: 26,
    status: {
      checks: store.cached[0].snapshot,
      reviewDecision: null,
      mergeable: null,
      mergeStateStatus: null,
    },
  });
});

test('a live refresh broadcasts the complete status patch for one PR', async () => {
  const rows = new Map([[26, openPr(26)]]);
  const store = recordingStore(rows);
  const client = {
    checkRuns: async () => [
      {
        name: 'build',
        status: 'completed',
        conclusion: 'success',
        details_url: 'https://example.test/checks/1',
        started_at: null,
        completed_at: null,
      },
    ],
    combinedStatus: async () => null,
    pull: async () => ({ mergeable: false, mergeable_state: 'dirty' }),
    prReviewList: async () => ({
      reviews: [{ state: 'CHANGES_REQUESTED', user: { login: 'reviewer' } }],
      truncated: false,
    }),
  };
  const broadcasts = [];
  const checks = new PrChecks(store, () => client, (msg) => broadcasts.push(msg));

  await checks.fetchSummary('moxxy-ai/companion', 26, 'maintainer');

  assert.equal(broadcasts.length, 1);
  assert.deepEqual(broadcasts[0], {
    t: 'prStatus.changed',
    repo: 'moxxy-ai/companion',
    number: 26,
    status: {
      checks: store.cached[0].snapshot,
      reviewDecision: 'changes_requested',
      mergeable: false,
      mergeStateStatus: 'dirty',
    },
  });
});

test('a superseded cancelled run does not make a green PR read as failing', () => {
  // rayf#296: `cancel-in-progress` left `triage` and `swift` cancelled on the same commit
  // as their successful re-runs. Counting every attempt read the pull request as failing,
  // sent its task to CI repair three times, and blocked a merge Octopus had approved.
  const runs = [
    { name: 'triage', status: 'completed', conclusion: 'cancelled', startedAt: 100, completedAt: 110 },
    { name: 'triage', status: 'completed', conclusion: 'success', startedAt: 200, completedAt: 210 },
    { name: 'swift', status: 'completed', conclusion: 'cancelled', startedAt: 100, completedAt: 115 },
    { name: 'swift', status: 'completed', conclusion: 'skipped', startedAt: 200, completedAt: 220 },
    { name: 'check', status: 'completed', conclusion: 'success', startedAt: 200, completedAt: 230 },
  ];

  const current = latestPerName(runs);
  assert.equal(current.length, 3, 'one entry per check name');
  assert.equal(current.find((r) => r.name === 'triage').conclusion, 'success');
  assert.equal(current.find((r) => r.name === 'swift').conclusion, 'skipped');
});

test('a genuine failure still fails, even beside an older success', () => {
  const runs = [
    { name: 'check', status: 'completed', conclusion: 'success', startedAt: 100, completedAt: 110 },
    { name: 'check', status: 'completed', conclusion: 'failure', startedAt: 200, completedAt: 210 },
  ];
  assert.equal(latestPerName(runs)[0].conclusion, 'failure');
});

test('a re-run still deciding outranks the finished attempt it replaced', () => {
  const runs = [
    { name: 'check', status: 'completed', conclusion: 'failure', startedAt: 100, completedAt: 110 },
    { name: 'check', status: 'in_progress', conclusion: null, startedAt: 200, completedAt: null },
  ];
  assert.equal(latestPerName(runs)[0].status, 'in_progress');
});
