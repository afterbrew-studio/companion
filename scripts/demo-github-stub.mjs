#!/usr/bin/env node
/**
 * A GitHub API stand-in for the demo instance the README screenshots are taken
 * from, pointed at with COMPANION_GITHUB_API_URL (the same knob GitHub
 * Enterprise uses):
 *
 *   node scripts/demo-github-stub.mjs
 *   COMPANION_HOME=/tmp/companion-demo/.companion \
 *     COMPANION_GITHUB_API_URL=http://127.0.0.1:8902 node apps/api/dist/index.js
 *
 * Why it exists: repository access is graded from what GitHub reports for the
 * resolving token, so a seeded row alone reads as "no access" and every
 * issue/PR view hides its contents. This answers the one question that gate
 * asks (what may this token do here) and returns empty feeds for everything
 * else, because sync only ever upserts and so leaves the seeded rows standing.
 *
 * It is a fixture, not a GitHub implementation: it grants whatever it is asked
 * about. Only ever point a throwaway instance at it.
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8902);
const LOGIN = 'acme-bot';

/** The change the demo's open fix PR carries, matching its agent run's transcript. */
const FILES = [
  {
    filename: 'src/settlement/refund.ts',
    status: 'modified',
    additions: 9,
    deletions: 4,
    changes: 13,
    patch: `@@ -1,12 +1,17 @@
 export async function settleRefund(refund: Refund): Promise<void> {
+  // The pending row is committed on its own: the approval below can wait on a
+  // person for hours, and holding the account's row lock across that wait is
+  // what stalled every later write on the same account.
   await db.transaction(async (tx) => {
     await tx.ledger.insert(pendingEntry(refund));
+  });

-    if (refund.amount > APPROVAL_THRESHOLD) {
-      await approvals.waitFor(refund.id);
-    }
+  if (refund.amount > APPROVAL_THRESHOLD) {
+    await approvals.waitFor(refund.id);
+  }

-    const receipt = await processor.confirm(refund);
+  const receipt = await processor.confirm(refund);
+  await db.transaction(async (tx) => {
     await tx.ledger.settle(refund.id, receipt);
   });
 }`,
  },
  {
    filename: 'src/settlement/refund.settlement.test.ts',
    status: 'added',
    additions: 34,
    deletions: 0,
    changes: 34,
    patch: `@@ -0,0 +1,34 @@
+test('a second write on the account completes while an approval is outstanding', async () => {
+  const refund = await givenRefund({ amount: 25_000 });
+  const settling = settleRefund(refund);
+
+  await expect(
+    withTimeout(ledger.append(refund.accountId, adjustment()), 500),
+  ).resolves.toBeDefined();
+
+  approvals.resolve(refund.id);
+  await settling;
+});`,
  },
];

const SUITE = ['build', 'unit', 'contract-tests', 'lint', 'typecheck', 'ledger-export'];

/**
 * Which pull requests report something other than a clean suite. The seeder
 * puts the PR number in the first four characters of the head sha, which is the
 * only handle this stub has on which pull request it is being asked about.
 */
const CI = {
  417: { failed: ['contract-tests', 'ledger-export'] },
  230: { failed: ['lint'] },
  415: { running: ['contract-tests', 'typecheck', 'ledger-export'] },
  236: { running: ['build', 'unit', 'typecheck'] },
};

function checkRuns(sha) {
  const { failed = [], running = [] } = CI[Number(sha.slice(0, 4))] ?? {};
  return SUITE.map((name, index) => ({
    id: 8_100_000 + index,
    name,
    status: running.includes(name) ? 'in_progress' : 'completed',
    conclusion: running.includes(name) ? null : failed.includes(name) ? 'failure' : 'success',
    details_url: `https://ci.acme.test/runs/${8_100_000 + index}`,
    started_at: new Date(1_785_000_000_000 - (96 - index * 6) * 1_000).toISOString(),
    completed_at: running.includes(name) ? null : new Date(1_785_000_000_000).toISOString(),
  }));
}

const COMMENTS = [
  {
    user: { login: 'jordan-lee' },
    body: 'Reproduced on staging: two refunds over the threshold on the same account, the second one sits in `pending` until the first is approved.',
    created_at: new Date(1_785_000_000_000).toISOString(),
  },
  {
    user: { login: 'priya-n' },
    body: 'Worth checking whether payouts share the settlement path. If they do, the same wait would stall those too.',
    created_at: new Date(1_785_090_000_000).toISOString(),
  },
];

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  const json = (body) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const repo = pathname.match(/^\/repos\/([\w.-]+)\/([\w.-]+)$/);
  if (repo) {
    const [, owner, name] = repo;
    return json({
      id: hash(`${owner}/${name}`),
      name,
      full_name: `${owner}/${name}`,
      private: true,
      default_branch: 'main',
      owner: { login: owner, type: 'Organization' },
      permissions: { admin: false, maintain: true, push: true, triage: true, pull: true },
    });
  }

  // A pull request's changed files, which is what the PR page draws its diff
  // from. Served for any number: the demo only ever opens one.
  if (/^\/repos\/[\w.-]+\/[\w.-]+\/pulls\/\d+\/files$/.test(pathname)) return json(FILES);

  // The conversation on an issue or a pull request (GitHub serves both here).
  if (/^\/repos\/[\w.-]+\/[\w.-]+\/issues\/\d+\/comments$/.test(pathname)) return json(COMMENTS);

  // CI for a commit. The suite reported here is what the PR page's checks
  // panel and the pipeline's gate step both read.
  const checks = pathname.match(/^\/repos\/[\w.-]+\/[\w.-]+\/commits\/([\w.-]+)\/check-runs$/);
  if (checks) {
    const runs = checkRuns(checks[1]);
    return json({ total_count: runs.length, check_runs: runs });
  }
  if (/^\/repos\/[\w.-]+\/[\w.-]+\/commits\/[\w.-]+\/status$/.test(pathname)) {
    return json({ state: 'success', statuses: [], total_count: 0 });
  }

  // The feeds: empty, so a sync neither fails the repo nor overwrites the seed.
  if (/^\/repos\/[\w.-]+\/[\w.-]+\/(issues|pulls|commits|labels|milestones|hooks)$/.test(pathname)) return json([]);
  if (/^\/repos\/[\w.-]+\/[\w.-]+\/pulls\/\d+\/(commits|reviews|comments)$/.test(pathname)) return json([]);
  if (pathname === '/user') return json({ login: LOGIN, id: 1, type: 'User' });
  if (pathname === '/rate_limit') return json({ resources: {}, rate: { limit: 5000, remaining: 5000, reset: 0 } });

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ message: 'Not Found' }));
});

server.listen(PORT, '127.0.0.1', () => console.log(`demo GitHub stub on http://127.0.0.1:${PORT}`));

function hash(value) {
  let out = 0;
  for (const char of value) out = (out * 31 + char.charCodeAt(0)) % 1_000_000;
  return out;
}
