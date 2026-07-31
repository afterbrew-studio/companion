#!/usr/bin/env node
/**
 * Fill a throwaway Companion instance with the data the README screenshots
 * show, so the images can be regenerated without pointing a camera at anyone's
 * real workspace.
 *
 *   npx @moxxy/companion --home /tmp/companion-demo/.companion   # once, to migrate
 *   node scripts/demo-seed.mjs --home /tmp/companion-demo/.companion
 *
 * The data directory must already have been created and migrated by a first
 * boot: this writes rows, it does not own the schema. Every table it touches is
 * cleared first, so re-running gives the same instance rather than a growing
 * one. Timestamps are relative to the moment it runs, which is what keeps the
 * "3h ago" column in the screenshots looking alive.
 *
 * Never point it at a real data directory.
 */

import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BEFORE = `export async function settleRefund(refund: Refund): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.ledger.insert(pendingEntry(refund));

    if (refund.amount > APPROVAL_THRESHOLD) {
      await approvals.waitFor(refund.id);
    }

    const receipt = await processor.confirm(refund);
    await tx.ledger.settle(refund.id, receipt);
  });
}
`;

const AFTER = `export async function settleRefund(refund: Refund): Promise<void> {
  // The pending row is committed on its own: the approval below can wait on a
  // person for hours, and holding the account's row lock across that wait is
  // what stalled every later write on the same account.
  await db.transaction(async (tx) => {
    await tx.ledger.insert(pendingEntry(refund));
  });

  if (refund.amount > APPROVAL_THRESHOLD) {
    await approvals.waitFor(refund.id);
  }

  const receipt = await processor.confirm(refund);
  await db.transaction(async (tx) => {
    await tx.ledger.settle(refund.id, receipt);
  });
}
`;

const home = readHome(process.argv.slice(2));
const db = new DatabaseSync(join(home, 'companion.db'));

const now = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const WORKSPACE = 'ws-demo';
const ADMIN = 'admin';
const REPOS = ['acme/payments-api', 'acme/web-storefront', 'acme/mobile-app'];

const insert = (table, rows) => {
  if (!rows.length) return;
  const columns = Object.keys(rows[0]);
  const statement = db.prepare(
    `INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
  );
  for (const row of rows) statement.run(...columns.map((column) => row[column]));
};

for (const table of [
  'workspaces',
  'workspace_members',
  'repos',
  'repo_workspaces',
  'issues',
  'prs',
  'runs',
  'pipelines',
  'github_accounts',
  'github_account_workspaces',
]) {
  db.exec(`DELETE FROM ${table}`);
}

/**
 * The credential the repositories resolve through. Repo access is graded from
 * what GitHub reports for the resolving token, so without a connected account
 * every issue and PR view renders as "no access" no matter what is in the
 * tables. Paired with scripts/demo-github-stub.mjs, which answers that grading
 * question; the token itself is a placeholder and authenticates nothing.
 */
insert('github_accounts', [
  {
    id: 'gha-demo',
    login: 'acme-bot',
    token: 'demo-fixture-token',
    purposes: JSON.stringify(['fetch', 'runs', 'pipelines', 'webhooks']),
    scope: 'all',
    owner_id: ADMIN,
    kind: 'pat',
    created_at: now - 40 * DAY,
  },
]);

insert('workspaces', [
  {
    id: WORKSPACE,
    name: 'Acme Platform',
    slug: 'acme-platform',
    description: 'Checkout, storefront and the mobile client.',
    visibility: 'private',
    owner_id: ADMIN,
    created_at: now - 40 * DAY,
  },
]);

insert('workspace_members', [
  { workspace_id: WORKSPACE, username: ADMIN, role: 'owner', created_at: now - 40 * DAY },
]);

insert(
  'repos',
  REPOS.map((fullName, index) => {
    const [owner, name] = fullName.split('/');
    return {
      full_name: fullName,
      owner,
      name,
      default_branch: 'main',
      private: 1,
      clone_ready: 1,
      last_sync_at: now - (6 + index * 4) * MIN,
      auto_triage: index === 0 ? 1 : 0,
      digest_enabled: 1,
      stale_enabled: index === 0 ? 1 : 0,
      pr_gate: index === 0 ? 1 : 0,
      workspace_id: WORKSPACE,
      auto_merge: 0,
      verify_command: index === 0 ? 'pnpm test' : null,
    };
  }),
);

insert(
  'repo_workspaces',
  REPOS.map((repo) => ({ repo, workspace_id: WORKSPACE, created_at: now - 40 * DAY })),
);

const issues = [
  ['acme/payments-api', 412, 'Refunds above 10k stall in `pending` for hours', 'bug,priority:high', 'dana-w', 'open', 7, 3 * HOUR],
  ['acme/payments-api', 409, 'Idempotency keys are not honoured on retried captures', 'bug', 'jordan-lee', 'open', 4, 9 * HOUR],
  ['acme/payments-api', 401, 'Expose settlement currency on the ledger export', 'enhancement', 'priya-n', 'open', 2, 2 * DAY],
  ['acme/payments-api', 386, 'Webhook signature check rejects valid replays', 'bug,needs-triage', 'marco-b', 'open', 11, 4 * DAY],
  ['acme/payments-api', 377, 'Document the payout reconciliation window', 'documentation,good first issue', 'sam-ok', 'open', 1, 6 * DAY],
  ['acme/payments-api', 370, 'Ledger export times out past 500k rows', 'bug,performance', 'dana-w', 'closed', 14, 9 * DAY],
  ['acme/web-storefront', 233, 'Cart total flickers while a coupon is applied', 'bug,ui', 'priya-n', 'open', 5, 5 * HOUR],
  ['acme/web-storefront', 229, 'Add Apple Pay to the express checkout row', 'enhancement', 'jordan-lee', 'open', 8, 1 * DAY],
  ['acme/web-storefront', 221, 'Product images ship at 4x on mobile', 'performance', 'marco-b', 'open', 3, 3 * DAY],
  ['acme/mobile-app', 96, 'Session drops after a background push', 'bug,priority:high', 'sam-ok', 'open', 6, 11 * HOUR],
  ['acme/mobile-app', 91, 'Offline cart is lost on cold start', 'bug', 'dana-w', 'open', 2, 2 * DAY],
  ['acme/mobile-app', 84, 'Bump the minimum supported iOS to 16', 'chore', 'priya-n', 'closed', 4, 8 * DAY],
];

// Creation is spread back over the quarter the dashboard charts, so the
// velocity trends read like a team's history rather than one seeding run.
insert(
  'issues',
  issues.map(([repo, number, title, labels, author, state, comments, age], index) => ({
    repo,
    number,
    title,
    body: '',
    state,
    labels: JSON.stringify(labels.split(',')),
    author,
    assignees: '[]',
    comments,
    url: `https://github.com/${repo}/issues/${number}`,
    created_at: now - age - index * 7 * DAY,
    updated_at: now - age,
    closed_at: state === 'closed' ? now - age : null,
  })),
);

const checks = (state, passed, failed, pending) => ({ state, total: passed + failed + pending, passed, failed, pending, fetchedAt: now - 4 * MIN });

const prs = [
  ['acme/payments-api', 418, 'fix: hold refunds in a single settlement transaction', 'open', 'companion/fix-412', 'dana-w', 0, checks('passing', 6, 0, 0), 'approved', 'clean', 'bug', 9, 35 * MIN],
  ['acme/payments-api', 417, 'feat: settlement currency on the ledger export', 'open', 'feat/settlement-currency', 'priya-n', 0, checks('failing', 4, 2, 0), 'changes_requested', 'blocked', 'enhancement', 12, 2 * HOUR],
  ['acme/payments-api', 415, 'refactor: split the capture retry path', 'open', 'refactor/capture-retry', 'jordan-lee', 1, checks('pending', 3, 0, 3), null, 'unstable', '', 1, 5 * HOUR],
  ['acme/payments-api', 410, 'chore: pin the webhook signature test vectors', 'merged', 'chore/sig-vectors', 'marco-b', 0, checks('passing', 6, 0, 0), 'approved', 'clean', 'chore', 3, 1 * DAY],
  ['acme/payments-api', 404, 'perf: stream the ledger export', 'merged', 'perf/stream-export', 'dana-w', 0, checks('passing', 6, 0, 0), 'approved', 'clean', 'performance', 18, 3 * DAY],
  ['acme/web-storefront', 238, 'fix: settle the cart total before repainting', 'open', 'companion/fix-233', 'priya-n', 0, checks('passing', 4, 0, 0), null, 'clean', 'bug,ui', 2, 50 * MIN],
  ['acme/web-storefront', 236, 'feat: Apple Pay in the express row', 'open', 'feat/apple-pay', 'jordan-lee', 1, checks('pending', 1, 0, 3), null, 'unstable', 'enhancement', 6, 7 * HOUR],
  ['acme/web-storefront', 230, 'perf: serve responsive product images', 'open', 'perf/responsive-images', 'marco-b', 0, checks('failing', 3, 1, 0), 'changes_requested', 'dirty', 'performance', 9, 2 * DAY],
  ['acme/mobile-app', 99, 'fix: restore the session after a background push', 'open', 'companion/fix-96', 'sam-ok', 0, checks('passing', 5, 0, 0), 'approved', 'clean', 'bug', 4, 4 * HOUR],
  ['acme/mobile-app', 95, 'chore: raise the deployment target to iOS 16', 'merged', 'chore/ios-16', 'priya-n', 0, checks('passing', 5, 0, 0), 'approved', 'clean', 'chore', 2, 6 * DAY],
];

insert(
  'prs',
  prs.map(([repo, number, title, state, headRef, author, draft, check, decision, mergeState, labels, comments, age], index) => ({
    repo,
    number,
    title,
    state,
    head_ref: headRef,
    base_ref: 'main',
    author,
    url: `https://github.com/${repo}/pull/${number}`,
    body: '',
    draft,
    head_sha: null,
    checks: JSON.stringify(check),
    labels: JSON.stringify(labels ? labels.split(',') : []),
    assignees: '[]',
    comments,
    review_decision: decision,
    mergeable: mergeState === 'dirty' ? 0 : 1,
    merge_state: mergeState,
    created_at: now - age - index * 6 * DAY,
    updated_at: now - age,
    closed_at: state === 'merged' ? now - age : null,
  })),
);

const FIX_RUN = 'run-demo-fix-412';

const runs = [
  // moxxy, because the transcript below is a moxxy session log: Claude Code and
  // Codex runs are read back from their own harness's transcript instead.
  [FIX_RUN, 'fix', 'review', 'Fix #412: refunds above 10k stall in pending', 'acme/payments-api', 412, 'companion/fix-412', 'moxxy', 128_400, 9_120, null, 38 * MIN],
  ['run-demo-triage-96', 'triage', 'completed', 'Triage #96: session drops after a background push', 'acme/mobile-app', 96, null, 'moxxy', 41_800, 2_310, 'success', 3 * HOUR],
  ['run-demo-impl-229', 'implement', 'running', 'Implement: Apple Pay in the express checkout row', 'acme/web-storefront', 229, 'feat/apple-pay', 'moxxy', 96_700, 14_880, null, 22 * MIN],
  ['run-demo-review-417', 'analysis', 'completed', 'AI review: settlement currency on the ledger export', 'acme/payments-api', null, null, 'codex', 74_200, 5_640, 'success', 2 * HOUR],
  ['run-demo-triage-409', 'triage', 'completed', 'Triage #409: idempotency keys on retried captures', 'acme/payments-api', 409, null, 'moxxy', 38_100, 1_990, 'success', 8 * HOUR],
  ['run-demo-fix-233', 'fix', 'failed', 'Fix #233: cart total flickers while a coupon is applied', 'acme/web-storefront', 233, 'companion/fix-233', 'claude-code', 52_600, 4_410, 'verification_failed', 1 * DAY],
  ['run-demo-report', 'report', 'completed', 'Weekly digest: Acme Platform', null, null, null, 'moxxy', 22_900, 3_150, 'success', 2 * DAY],
];

insert(
  'runs',
  runs.map(([id, kind, status, title, repo, issueNumber, branch, harness, input, output, outcome, age]) => ({
    id,
    kind,
    status,
    title,
    cwd: repo ? `/tmp/companion-demo/.companion/worktrees/${id}` : '/tmp/companion-demo/.companion/scratch',
    repo,
    issue_number: issueNumber,
    created_at: now - age - 12 * MIN,
    updated_at: now - age,
    input_tokens: input,
    output_tokens: output,
    outcome,
    // A repo-bound run is visible to the profile that started it, so a demo
    // where the admin sees nothing is a demo of the access rule, not the app.
    user_id: ADMIN,
    branch,
    harness,
    model: harness === 'claude-code' ? 'claude-opus-5' : harness === 'codex' ? 'gpt-5-codex' : 'claude-sonnet-5',
    task: kind,
  })),
);

insert('pipelines', [
  {
    id: 'pipeline-demo-pr-gate',
    workspace_id: WORKSPACE,
    name: 'PR gate',
    description: 'What every pull request into main has to clear.',
    type: 'pr',
    auto_run: 1,
    steps: JSON.stringify([
      { kind: 'checks-gate', name: 'CI is green', onFailure: 'halt', config: { allowPending: false, requireProtectedContexts: true } },
      { kind: 'ai-review', name: 'AI review', onFailure: 'continue', config: { post: true, failOn: 'request_changes' } },
      { kind: 'agent', name: 'Check the migration is additive', onFailure: 'halt', config: { prompt: 'Inspect any SQL migration in this diff. Fail if a column or table is dropped or renamed rather than added.' } },
      { kind: 'label', name: 'Mark it reviewed', onFailure: 'continue', config: { labels: ['reviewed'] } },
    ]),
    created_at: now - 30 * DAY,
    updated_at: now - 5 * DAY,
  },
]);

writeTranscript(FIX_RUN);
writeWorktree(FIX_RUN, 'companion/fix-412');

db.close();
console.log(`Seeded the demo instance in ${home}: ${REPOS.length} repos, ${issues.length} issues, ${prs.length} pull requests, ${runs.length} runs.`);

/**
 * The transcript the run detail screenshot shows. A reaped run's history is
 * read straight off this file (see modules/operate/src/exec/history.ts), so a
 * seeded run needs no gateway to render.
 */
function writeTranscript(runId) {
  const directory = join(home, 'moxxy-home', 'sessions');
  mkdirSync(directory, { recursive: true });

  let seq = 0;
  const start = now - 50 * MIN;
  const event = (type, fields) => {
    seq += 1;
    return JSON.stringify({
      id: `${runId}-${seq}`,
      seq,
      ts: start + seq * 9_000,
      sessionId: runId,
      turnId: `${runId}-turn-1`,
      source: 'harness',
      type,
      ...fields,
    });
  };

  const lines = [
    event('user_prompt', {
      text: 'Issue #412: refunds above 10k stall in `pending` for hours. Find the cause, fix it, and add a regression test.',
      origin: { kind: 'issue', name: 'acme/payments-api#412' },
    }),
    event('reasoning_message', {
      content:
        'Two settlement writes on the same refund means the second one waits on a row lock held across an HTTP call to the processor. Above the 10k threshold the code takes the manual-approval branch, which is where that second write lives, so only large refunds stall. Read the settlement path before changing anything.',
    }),
    event('tool_call_requested', { callId: 'call-1', name: 'read_file', input: { path: 'src/settlement/refund.ts' } }),
    event('tool_call_approved', { callId: 'call-1' }),
    event('tool_result', { callId: 'call-1', ok: true, output: '214 lines' }),
    event('assistant_message', {
      content:
        '`settleRefund` opens a transaction, then awaits `processor.confirm()` inside it. For refunds over the approval threshold that call blocks on a human, so the row lock is held for as long as the approval takes and every later write on the same account queues behind it.',
    }),
    event('tool_call_requested', {
      callId: 'call-2',
      name: 'edit_file',
      input: { path: 'src/settlement/refund.ts', summary: 'Commit the pending row before confirming with the processor' },
    }),
    event('tool_call_approved', { callId: 'call-2' }),
    event('tool_result', { callId: 'call-2', ok: true, output: '1 file changed, 23 insertions(+), 9 deletions(-)' }),
    event('tool_call_requested', { callId: 'call-3', name: 'run_command', input: { command: 'pnpm test settlement' } }),
    event('tool_call_approved', { callId: 'call-3' }),
    event('tool_result', { callId: 'call-3', ok: true, output: '42 passed, 0 failed (4.1s)' }),
    event('provider_response', { inputTokens: 128_400, outputTokens: 9_120 }),
    event('assistant_message', {
      content:
        'Fixed. The pending row is now committed before the processor is asked to confirm, so the approval wait no longer holds a lock. Added `refund.settlement.test.ts`, which fails on the old code by asserting a second write on the same account completes while an approval is outstanding. Branch `companion/fix-412` is ready for review.',
    }),
  ];

  writeFileSync(join(directory, `${runId}.jsonl`), `${lines.join('\n')}\n`, { mode: 0o600 });
}

/**
 * The branch the run left behind. A run in review renders its diff by asking
 * git for `origin/<base>...HEAD` inside the run's working directory, so the
 * review card needs a real repository with a real base ref, not just a row.
 * The change is the one the transcript above describes.
 */
function writeWorktree(runId, branch) {
  const worktree = join(home, 'worktrees', runId);
  const file = join(worktree, 'src', 'settlement', 'refund.ts');
  rmSync(worktree, { recursive: true, force: true });
  mkdirSync(join(worktree, 'src', 'settlement'), { recursive: true });

  const git = (...args) =>
    execFileSync('git', ['-C', worktree, '-c', 'user.name=Companion', '-c', 'user.email=demo@companion.local', ...args], {
      stdio: 'pipe',
    });

  writeFileSync(file, BEFORE);
  git('init', '--initial-branch=main', '--quiet');
  git('add', '-A');
  git('commit', '--quiet', '-m', 'settlement: confirm refunds with the processor');
  // Stand in for the remote the worktree was cut from, which is what the diff
  // is taken against.
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '--quiet', '-b', branch);
  writeFileSync(file, AFTER);
  git('add', '-A');
  git('commit', '--quiet', '-m', 'fix: commit the pending row before confirming');
}

function readHome(argv) {
  const index = argv.indexOf('--home');
  const value = index === -1 ? process.env.COMPANION_HOME : argv[index + 1];
  if (!value) {
    console.error('Usage: node scripts/demo-seed.mjs --home <data directory>');
    process.exit(1);
  }
  return value;
}
