import assert from 'node:assert/strict';
import test from 'node:test';
import { PrChecks, UnknownPrError } from '../dist/api/pr-checks.js';

function openPr(number) {
  return { repo: 'moxxy-ai/companion', number, state: 'open', headSha: `sha${number}`, checks: null };
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
    prReviewList: async () => [],
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
