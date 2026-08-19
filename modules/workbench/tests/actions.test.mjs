import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import migrations from '../dist/api/migrations.js';
import { WorkbenchActionsStore } from '../dist/api/workbench-actions-store.js';
import { WORKBENCH_ACTIONS, WorkbenchActions } from '../dist/api/workbench-actions.js';

const user = { username: 'maintainer', displayName: 'Maintainer', role: 'maintainer' };

test('catalog has one centrally-authorized definition for every supported action', () => {
  assert.deepEqual(
    WORKBENCH_ACTIONS.map((item) => item.id),
    [
      'run.approve',
      'run.discard',
      'pr-review.apply',
      'pr-review.dismiss',
      'pr.comment',
      'pr.review-comment.reply',
      'pr.review-comment.create',
      'pr.review-thread.resolve',
      'pr.labels.add',
      'pr.labels.remove',
      'pr.reviewers.request',
      'pr.reviewers.remove',
      'pr.assignees.add',
      'pr.assignees.remove',
      'pr.review.submit',
      'pr.checks.rerun',
      'pr.update-branch',
      'pr.ready',
      'pr.close',
      'pr.reopen',
      'pr.merge',
      'issue-triage.apply',
      'issue-triage.dismiss',
      'issue.comment',
      'issue.close',
      'issue.reopen',
      'issue.labels.add',
      'issue.labels.remove',
      'issue.assignees.add',
      'issue.assignees.remove',
      'board.merge',
      'board.retry',
      'spec.create',
      'doc.create',
    ],
  );
  assert.equal(new Set(WORKBENCH_ACTIONS.map((item) => item.id)).size, WORKBENCH_ACTIONS.length);
  assert.equal(WORKBENCH_ACTIONS.every((item) => item.access[0] === 'workbench:read'), true);
});

function fixture(overrides = {}) {
  const db = new Database(':memory:');
  for (const migration of migrations) migration.up(db);
  const changed = [];
  const audits = [];
  const created = [];
  const domain = { discards: 0, comments: [], writes: [], syncs: [] };
  let run = {
    id: 'run-1',
    repo: 'acme/app',
    title: 'Implement search',
    status: 'review',
    updatedAt: 10,
  };
  let pr = overrides.pr ?? null;
  let issue = overrides.issue ?? null;
  let reviewThreads = overrides.reviewThreads ?? [];
  const workspace = {
    requireAccessible: (_user, id) => assert.equal(id, 'ws-1'),
    canAccessWorkspace: () => true,
    canAccessRepo: () => true,
  };
  const operate = { requireRunAccess: () => run };
  const githubClient = {
    issue: async (repo, number) => {
      const target = pr?.repo === repo && pr.number === number ? pr : issue;
      if (!target) throw new Error('not found');
      return {
        number,
        title: target.title,
        state: target.state === 'open' ? 'open' : 'closed',
        updated_at: new Date(target.updatedAt).toISOString(),
        comments: target.comments ?? 0,
        labels: target.labels ?? [],
        assignees: (target.assignees ?? []).map((login) => ({ login })),
        ...(target === pr ? { pull_request: {} } : {}),
      };
    },
    pull: async (repo, number) => {
      if (!pr || pr.repo !== repo || pr.number !== number) throw new Error('not found');
      return {
        number,
        title: pr.title,
        state: pr.state === 'open' ? 'open' : 'closed',
        draft: pr.draft ?? false,
        merged_at: pr.mergedAt ?? null,
        updated_at: new Date(pr.updatedAt).toISOString(),
        head: { sha: pr.headSha ?? 'head-1' },
        base: { ref: pr.baseRef ?? 'main' },
        requested_reviewers: (pr.requestedReviewers ?? []).map((login) => ({ login })),
      };
    },
    prReviewThreads: async () => ({ threads: reviewThreads, truncated: false }),
    prFiles: async () => ({
      files: overrides.files ?? [{
        filename: 'src/search.ts',
        status: 'modified',
        additions: 1,
        deletions: 1,
        patch: '@@ -1,2 +1,2 @@\n const query = input.trim();\n-return risky;\n+return safe;',
      }],
      truncated: false,
    }),
    comment: async (targetRepo, number, body) => {
      domain.comments.push({ targetRepo, number, body });
      return { html_url: `https://github.test/${targetRepo}/issues/${number}#comment` };
    },
    addLabels: async (repo, number, labels) => domain.writes.push(['labels', repo, number, labels]),
    requestReviewers: async (repo, number, reviewers) => domain.writes.push(['reviewers', repo, number, reviewers]),
    removeReviewers: async (repo, number, reviewers) => domain.writes.push(['remove-reviewers', repo, number, reviewers]),
    addAssignees: async (repo, number, assignees) => domain.writes.push(['assignees', repo, number, assignees]),
    removeAssignees: async (repo, number, assignees) => domain.writes.push(['remove-assignees', repo, number, assignees]),
    removeLabel: async (repo, number, label) => domain.writes.push(['remove-label', repo, number, label]),
    updateIssueState: async (repo, number, state) => domain.writes.push(['issue-state', repo, number, state]),
    replyToReviewComment: async (repo, number, commentId, body) => {
      domain.writes.push(['reply', repo, number, commentId, body]);
      return { id: 900, html_url: 'https://github.test/comment/900' };
    },
    createReviewComment: async (repo, number, comment) => {
      domain.writes.push(['inline', repo, number, comment]);
      return { id: 901, html_url: 'https://github.test/comment/901' };
    },
    resolveReviewThread: async (threadId) => domain.writes.push(['resolve-thread', threadId]),
    createPrReview: async (repo, number, input) => {
      domain.writes.push(['submit-review', repo, number, input]);
      return { id: 902, html_url: 'https://github.test/review/902' };
    },
    rerunChecks: async (repo, head, scope) => {
      domain.writes.push(['rerun', repo, head, scope]);
      return 2;
    },
    updateBranch: async (repo, number) => domain.writes.push(['update-branch', repo, number]),
    markReadyForReview: async (repo, number) => domain.writes.push(['ready', repo, number]),
    closePr: async (repo, number) => domain.writes.push(['pr-state', repo, number, 'closed']),
    reopenPr: async (repo, number) => domain.writes.push(['pr-state', repo, number, 'open']),
  };
  const code = {
    repos: { inWorkspace: () => true },
    githubAccounts: {
      permissionFor: async () => ({ accountId: 'gh-1' }),
      verifiedClientFor: async () => ({ client: githubClient, account: {}, permission: 'push', tried: [] }),
      performForRepo: async (purpose, repo, action, context) => ({
        result: await action({
          ...githubClient,
          comment: async (targetRepo, number, body) => {
            domain.comments.push({ purpose, repo, context, targetRepo, number, body });
            return { html_url: `https://github.test/${targetRepo}/issues/${number}#comment` };
          },
        }),
        client: {},
        tried: [],
      }),
    },
    fixes: {
      approve: async () => ({ prUrl: 'https://github.test/acme/app/pull/1' }),
      discard: async () => {
        domain.discards += 1;
      },
    },
    prs: { get: () => pr },
    prReviews: {
      merge: async (repo, number, method, username) => domain.writes.push(['merge', repo, number, method, username]),
    },
    issues: { get: () => issue },
    triage: {},
    sync: {
      syncPr: async (...args) => domain.syncs.push(['pr', ...args]),
      syncIssue: async (...args) => domain.syncs.push(['issue', ...args]),
    },
  };
  const plan = {
    specs: {
      create: (...args) => {
        created.push(args);
        return { id: 'spec-1', title: args[2] };
      },
    },
    docs: { create: () => ({ id: 'doc-1', title: 'Documentation' }) },
  };
  const actions = new WorkbenchActions(
    new WorkbenchActionsStore(db),
    workspace,
    operate,
    code,
    () => overrides.board,
    () => overrides.plan ?? plan,
    (username) => changed.push(username),
    (event) => audits.push(event),
  );
  return {
    actions,
    audits,
    changed,
    created,
    domain,
    db,
    setRun: (next) => {
      run = next;
    },
    setPr: (next) => {
      pr = next;
    },
    setIssue: (next) => {
      issue = next;
    },
    setReviewThreads: (next) => {
      reviewThreads = next;
    },
  };
}

test('prepares exact reviewed content, revalidates it, and executes through Plan', async () => {
  const f = fixture();
  const request = {
    action: 'spec.create',
    repo: 'acme/app',
    title: 'Search requirements',
    content: '# Search\n\nUsers can find repositories by name.',
  };
  const prepared = await f.actions.prepare(user, 'ws-1', request, 'assistant');

  assert.equal(prepared.status, 'pending');
  assert.equal(prepared.source, 'assistant');
  assert.deepEqual(prepared.request, request);
  assert.equal(prepared.result, null);

  const completed = await f.actions.execute(user, prepared.id, 'spec.create');
  assert.equal(completed.status, 'completed');
  assert.equal(completed.result.href, '#/specs');
  assert.deepEqual(f.created, [
    ['ws-1', 'acme/app', 'Search requirements', request.content, 'virtual'],
  ]);
  assert.deepEqual(f.changed, ['maintainer', 'maintainer', 'maintainer']);
  assert.equal(f.audits.length, 1);
  assert.equal(f.audits[0].action, 'workbench.spec.create');
  assert.equal(f.audits[0].status, 200);
  await assert.rejects(() => f.actions.execute(user, prepared.id, 'spec.create'), /completed, not pending/);
  f.db.close();
});

test('prepares an exact PR comment and only posts it after human execution', async () => {
  const pr = {
    repo: 'acme/app',
    number: 7,
    title: 'Improve search',
    state: 'open',
    updatedAt: 20,
    comments: 2,
  };
  const f = fixture({ pr });
  const request = {
    action: 'pr.comment',
    repo: 'acme/app',
    number: 7,
    body: 'Thanks — please add a regression test for the empty query case.',
  };

  const prepared = await f.actions.prepare(user, 'ws-1', request, 'assistant');
  assert.equal(prepared.status, 'pending');
  assert.deepEqual(prepared.request, request);
  assert.match(prepared.title, /PR #7/);
  assert.deepEqual(f.domain.comments, []);

  const completed = await f.actions.execute(user, prepared.id, 'pr.comment');
  assert.equal(completed.status, 'completed');
  assert.equal(completed.result.href, '#/repos/acme/app/prs/7');
  assert.deepEqual(f.domain.comments, [{
    purpose: 'pipelines',
    repo: 'acme/app',
    context: { username: 'maintainer', workspaceId: 'ws-1', need: 'push' },
    targetRepo: 'acme/app',
    number: 7,
    body: request.body,
  }]);
  assert.deepEqual(f.domain.syncs, [['pr', 'acme/app', 7, 'maintainer', 'ws-1']]);
  f.db.close();
});

test('refuses a prepared PR comment after the conversation changed', async () => {
  const f = fixture({
    pr: { repo: 'acme/app', number: 7, title: 'Improve search', state: 'open', updatedAt: 20, comments: 2 },
  });
  const prepared = await f.actions.prepare(
    user,
    'ws-1',
    { action: 'pr.comment', repo: 'acme/app', number: 7, body: 'Looks good.' },
    'assistant',
  );
  f.setPr({ repo: 'acme/app', number: 7, title: 'Improve search', state: 'open', updatedAt: 21, comments: 3 });

  await assert.rejects(() => f.actions.execute(user, prepared.id, 'pr.comment'), /target changed/);
  assert.deepEqual(f.domain.comments, []);
  f.db.close();
});

test('replies, suggests on a line, and resolves the exact fresh review thread after approval', async () => {
  const thread = {
    id: 'PRRT_thread_1',
    isResolved: false,
    isOutdated: false,
    path: 'src/search.ts',
    line: 2,
    comments: {
      nodes: [{
        id: 'PRRC_comment_501',
        databaseId: 501,
        author: { login: 'sara' },
        body: 'Can this avoid the unsafe fallback?',
        createdAt: '2026-08-19T10:00:00Z',
        url: 'https://github.test/acme/app/pull/7#discussion_r501',
        path: 'src/search.ts',
        line: 2,
        originalLine: 2,
        replyTo: null,
      }],
    },
  };
  const f = fixture({
    pr: {
      repo: 'acme/app', number: 7, title: 'Improve search', state: 'open', updatedAt: 20,
      comments: 2, headSha: 'abc123', baseRef: 'main',
    },
    reviewThreads: [thread],
  });
  const reply = await f.actions.prepare(user, 'ws-1', {
    action: 'pr.review-comment.reply',
    repo: 'acme/app',
    number: 7,
    commentId: 501,
    body: 'Yes. This keeps the fallback typed and covered by the regression test.',
  }, 'assistant');
  const inline = await f.actions.prepare(user, 'ws-1', {
    action: 'pr.review-comment.create',
    repo: 'acme/app',
    number: 7,
    path: 'src/search.ts',
    side: 'RIGHT',
    line: 2,
    quotedLine: 'return safe;',
    body: 'Use the guarded result here.',
    suggestion: 'return validated;',
  }, 'assistant');
  const resolve = await f.actions.prepare(user, 'ws-1', {
    action: 'pr.review-thread.resolve',
    repo: 'acme/app',
    number: 7,
    threadId: 'PRRT_thread_1',
  }, 'assistant');

  assert.deepEqual(f.domain.writes, []);
  await f.actions.execute(user, reply.id, 'pr.review-comment.reply');
  await f.actions.execute(user, inline.id, 'pr.review-comment.create');
  await f.actions.execute(user, resolve.id, 'pr.review-thread.resolve');

  assert.deepEqual(f.domain.writes, [
    ['reply', 'acme/app', 7, 501, 'Yes. This keeps the fallback typed and covered by the regression test.'],
    ['inline', 'acme/app', 7, {
      commit_id: 'abc123',
      path: 'src/search.ts',
      body: 'Use the guarded result here.\n\n```suggestion\nreturn validated;\n```',
      line: 2,
      side: 'RIGHT',
    }],
    ['resolve-thread', 'PRRT_thread_1'],
  ]);
  f.db.close();
});

test('refuses a reply after its review thread receives a newer comment', async () => {
  const first = {
    id: 'PRRT_thread_1', isResolved: false, isOutdated: false, path: 'src/search.ts', line: 2,
    comments: { nodes: [{
      id: 'PRRC_comment_501', databaseId: 501, author: { login: 'sara' }, body: 'Please explain.',
      createdAt: '2026-08-19T10:00:00Z', url: 'https://github.test/c/501', path: 'src/search.ts',
      line: 2, originalLine: 2, replyTo: null,
    }] },
  };
  const f = fixture({
    pr: { repo: 'acme/app', number: 7, title: 'Improve search', state: 'open', updatedAt: 20, headSha: 'abc123' },
    reviewThreads: [first],
  });
  const prepared = await f.actions.prepare(user, 'ws-1', {
    action: 'pr.review-comment.reply', repo: 'acme/app', number: 7, commentId: 501, body: 'The guard handles it.',
  }, 'assistant');
  f.setReviewThreads([{ ...first, comments: { nodes: [...first.comments.nodes, {
    id: 'PRRC_comment_502', databaseId: 502, author: { login: 'james' }, body: 'I pushed another option.',
    createdAt: '2026-08-19T10:02:00Z', url: 'https://github.test/c/502', path: 'src/search.ts',
    line: 2, originalLine: 2, replyTo: { databaseId: 501 },
  }] } }]);

  await assert.rejects(() => f.actions.execute(user, prepared.id, 'pr.review-comment.reply'), /target changed/);
  assert.deepEqual(f.domain.writes, []);
  f.db.close();
});

test('prepares and posts an issue comment through the same approval boundary', async () => {
  const f = fixture({
    issue: { repo: 'acme/app', number: 11, title: 'Search is slow', state: 'open', updatedAt: 30, comments: 1 },
  });
  const request = {
    action: 'issue.comment',
    repo: 'acme/app',
    number: 11,
    body: 'I reproduced this on the current main branch. I will attach timings next.',
  };

  const prepared = await f.actions.prepare(user, 'ws-1', request, 'assistant');
  assert.deepEqual(f.domain.comments, []);
  const completed = await f.actions.execute(user, prepared.id, 'issue.comment');

  assert.equal(completed.status, 'completed');
  assert.equal(f.domain.comments[0].body, request.body);
  assert.deepEqual(f.domain.syncs, [['issue', 'acme/app', 11, 'maintainer', 'ws-1']]);
  f.db.close();
});

test('maintainer GitHub actions stay behind review and pin reruns to the reviewed head', async () => {
  const f = fixture({
    pr: {
      repo: 'acme/app', number: 7, title: 'Improve search', state: 'open', updatedAt: 20,
      comments: 2, labels: ['ui'], assignees: ['james'], requestedReviewers: ['alex'], headSha: 'abc123', baseRef: 'main',
    },
    issue: {
      repo: 'acme/app', number: 11, title: 'Search is slow', state: 'open', updatedAt: 30,
      comments: 1, labels: ['old'], assignees: ['james'],
    },
  });
  const requests = [
    { action: 'pr.labels.add', repo: 'acme/app', number: 7, labels: ['ready'] },
    { action: 'pr.labels.remove', repo: 'acme/app', number: 7, labels: ['ui'] },
    { action: 'pr.reviewers.request', repo: 'acme/app', number: 7, reviewers: ['sara'] },
    { action: 'pr.reviewers.remove', repo: 'acme/app', number: 7, reviewers: ['alex'] },
    { action: 'pr.assignees.add', repo: 'acme/app', number: 7, assignees: ['sara'] },
    { action: 'pr.assignees.remove', repo: 'acme/app', number: 7, assignees: ['james'] },
    { action: 'pr.review.submit', repo: 'acme/app', number: 7, verdict: 'approve', body: 'Verified the fix and regression coverage.' },
    { action: 'pr.checks.rerun', repo: 'acme/app', number: 7, scope: 'failed' },
    { action: 'pr.update-branch', repo: 'acme/app', number: 7 },
    { action: 'pr.merge', repo: 'acme/app', number: 7, method: 'squash' },
    { action: 'issue.labels.add', repo: 'acme/app', number: 11, labels: ['bug'] },
    { action: 'issue.labels.remove', repo: 'acme/app', number: 11, labels: ['old'] },
    { action: 'issue.assignees.add', repo: 'acme/app', number: 11, assignees: ['sara'] },
    { action: 'issue.assignees.remove', repo: 'acme/app', number: 11, assignees: ['james'] },
  ];

  for (const request of requests) {
    const prepared = await f.actions.prepare(user, 'ws-1', request, 'assistant');
    assert.equal(prepared.status, 'pending');
    assert.equal(f.domain.writes.length, requests.indexOf(request));
    await f.actions.execute(user, prepared.id, request.action);
  }

  assert.deepEqual(f.domain.writes, [
    ['labels', 'acme/app', 7, ['ready']],
    ['remove-label', 'acme/app', 7, 'ui'],
    ['reviewers', 'acme/app', 7, ['sara']],
    ['remove-reviewers', 'acme/app', 7, ['alex']],
    ['assignees', 'acme/app', 7, ['sara']],
    ['remove-assignees', 'acme/app', 7, ['james']],
    ['submit-review', 'acme/app', 7, {
      body: 'Verified the fix and regression coverage.',
      event: 'APPROVE',
      commitId: 'abc123',
    }],
    ['rerun', 'acme/app', 'abc123', 'failed'],
    ['update-branch', 'acme/app', 7],
    ['merge', 'acme/app', 7, 'squash', 'maintainer'],
    ['labels', 'acme/app', 11, ['bug']],
    ['remove-label', 'acme/app', 11, 'old'],
    ['assignees', 'acme/app', 11, ['sara']],
    ['remove-assignees', 'acme/app', 11, ['james']],
  ]);
  f.db.close();
});

test('closes an issue with the exact optional comment only after approval', async () => {
  const f = fixture({
    issue: { repo: 'acme/app', number: 11, title: 'Search is slow', state: 'open', updatedAt: 30, comments: 1 },
  });
  const prepared = await f.actions.prepare(user, 'ws-1', {
    action: 'issue.close',
    repo: 'acme/app',
    number: 11,
    comment: 'Fixed by #12 and verified on the current main branch.',
  }, 'assistant');

  assert.deepEqual(f.domain.comments, []);
  assert.deepEqual(f.domain.writes, []);
  await f.actions.execute(user, prepared.id, 'issue.close');
  assert.equal(f.domain.comments[0].body, 'Fixed by #12 and verified on the current main branch.');
  assert.deepEqual(f.domain.writes, [['issue-state', 'acme/app', 11, 'closed']]);
  f.db.close();
});

test('reopens an issue with reviewed content and refreshes its cached state', async () => {
  const f = fixture({
    issue: { repo: 'acme/app', number: 11, title: 'Search is slow', state: 'closed', updatedAt: 30, comments: 2 },
  });
  const prepared = await f.actions.prepare(user, 'ws-1', {
    action: 'issue.reopen',
    repo: 'acme/app',
    number: 11,
    comment: 'The regression returned on the current main branch.',
  }, 'assistant');

  await f.actions.execute(user, prepared.id, 'issue.reopen');
  assert.equal(f.domain.comments[0].body, 'The regression returned on the current main branch.');
  assert.deepEqual(f.domain.writes, [['issue-state', 'acme/app', 11, 'open']]);
  assert.deepEqual(f.domain.syncs, [['issue', 'acme/app', 11, 'maintainer', 'ws-1']]);
  f.db.close();
});

test('moves a draft PR into review only through an approved action', async () => {
  const f = fixture({
    pr: {
      repo: 'acme/app', number: 7, title: 'Improve search', state: 'open', draft: true,
      updatedAt: 20, headSha: 'abc123', baseRef: 'main',
    },
  });
  const prepared = await f.actions.prepare(user, 'ws-1', {
    action: 'pr.ready', repo: 'acme/app', number: 7,
  }, 'assistant');

  assert.deepEqual(f.domain.writes, []);
  await f.actions.execute(user, prepared.id, 'pr.ready');
  assert.deepEqual(f.domain.writes, [['ready', 'acme/app', 7]]);
  assert.deepEqual(f.domain.syncs, [['pr', 'acme/app', 7, 'maintainer', 'ws-1']]);
  f.db.close();
});

test('closes and reopens an unmerged PR with the exact reviewed comments', async () => {
  const open = fixture({
    pr: {
      repo: 'acme/app', number: 7, title: 'Improve search', state: 'open', draft: false,
      mergedAt: null, updatedAt: 20, headSha: 'abc123', baseRef: 'main',
    },
  });
  const close = await open.actions.prepare(user, 'ws-1', {
    action: 'pr.close', repo: 'acme/app', number: 7, comment: 'Closing because the replacement is now ready.',
  }, 'assistant');
  await open.actions.execute(user, close.id, 'pr.close');
  assert.deepEqual(open.domain.writes, [['pr-state', 'acme/app', 7, 'closed']]);
  assert.equal(open.domain.comments[0].body, 'Closing because the replacement is now ready.');
  open.db.close();

  const closed = fixture({
    pr: {
      repo: 'acme/app', number: 7, title: 'Improve search', state: 'closed', draft: false,
      mergedAt: null, updatedAt: 30, headSha: 'abc123', baseRef: 'main',
    },
  });
  const reopen = await closed.actions.prepare(user, 'ws-1', {
    action: 'pr.reopen', repo: 'acme/app', number: 7, comment: 'Reopening after the replacement was withdrawn.',
  }, 'assistant');
  await closed.actions.execute(user, reopen.id, 'pr.reopen');
  assert.deepEqual(closed.domain.writes, [['pr-state', 'acme/app', 7, 'open']]);
  assert.equal(closed.domain.comments[0].body, 'Reopening after the replacement was withdrawn.');
  closed.db.close();
});

test('does not submit a PR review while the pull request is still a draft', async () => {
  const f = fixture({
    pr: {
      repo: 'acme/app', number: 7, title: 'Improve search', state: 'open', draft: true,
      updatedAt: 20, headSha: 'abc123', baseRef: 'main',
    },
  });
  await assert.rejects(() => f.actions.prepare(user, 'ws-1', {
    action: 'pr.review.submit', repo: 'acme/app', number: 7,
    verdict: 'approve', body: 'Looks good.',
  }, 'assistant'), /marked ready/);
  assert.deepEqual(f.domain.writes, []);
  f.db.close();
});

test('refuses a stale proposal before claiming or touching its domain owner', async () => {
  const f = fixture();
  const prepared = await f.actions.prepare(user, 'ws-1', { action: 'run.discard', runId: 'run-1' }, 'assistant');
  f.setRun({
    id: 'run-1',
    repo: 'acme/app',
    title: 'Implement search',
    status: 'review',
    updatedAt: 11,
  });

  await assert.rejects(() => f.actions.execute(user, prepared.id, 'run.discard'), /target changed/);
  assert.equal(f.actions.list(user)[0].status, 'pending');
  assert.equal(f.domain.discards, 0);
  f.db.close();
});

test('pins a Board merge to the reviewed pull-request head', async () => {
  const merged = [];
  const task = {
    id: 'task-1',
    workspaceId: 'ws-1',
    repo: 'acme/app',
    title: 'Implement search',
    status: 'in_review',
    stage: 'awaiting_merge',
    prNumber: 7,
    updatedAt: 20,
  };
  const board = {
    getTask: () => ({ task }),
    mergeNow: async (...args) => {
      merged.push(args);
    },
  };
  const f = fixture({ board, pr: { state: 'open', headSha: 'abc123' } });
  const stale = await f.actions.prepare(user, 'ws-1', { action: 'board.merge', taskId: task.id }, 'assistant');
  f.setPr({ state: 'open', headSha: 'def456' });
  await assert.rejects(() => f.actions.execute(user, stale.id, 'board.merge'), /target changed/);
  assert.deepEqual(merged, []);

  const current = await f.actions.prepare(user, 'ws-1', { action: 'board.merge', taskId: task.id }, 'assistant');
  const completed = await f.actions.execute(user, current.id, 'board.merge');
  assert.equal(completed.status, 'completed');
  assert.deepEqual(merged, [[task.id, user.username, 'def456']]);
  f.db.close();
});

test('an action-specific execute route cannot be confused with another proposal kind', async () => {
  const f = fixture();
  const prepared = await f.actions.prepare(
    user,
    'ws-1',
    { action: 'spec.create', repo: 'acme/app', title: 'Search', content: '# Search' },
    'mcp',
  );

  await assert.rejects(() => f.actions.execute(user, prepared.id, 'doc.create'), /prepared action not found/);
  assert.equal(f.actions.list(user)[0].status, 'pending');
  assert.deepEqual(f.created, []);
  f.db.close();
});

test('records a failed proposal instead of ambiguously retrying a domain write', async () => {
  const f = fixture({
    plan: {
      specs: { create: () => { throw new Error('storage unavailable'); } },
      docs: { create: () => ({ id: 'unused', title: 'unused' }) },
    },
  });
  const prepared = await f.actions.prepare(
    user,
    'ws-1',
    { action: 'spec.create', repo: 'acme/app', title: 'Search', content: '# Search' },
    'ui',
  );
  const failed = await f.actions.execute(user, prepared.id, 'spec.create');

  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'storage unavailable');
  assert.equal(f.audits[0].status, 500);
  await assert.rejects(() => f.actions.execute(user, prepared.id, 'spec.create'), /failed, not pending/);
  f.db.close();
});

test('bounds proposals a delegated client can leave waiting for one person', async () => {
  const f = fixture();
  for (let index = 0; index < 25; index += 1) {
    await f.actions.prepare(
      user,
      'ws-1',
      { action: 'doc.create', title: `Note ${index}`, content: `# Note ${index}` },
      'assistant',
    );
  }

  await assert.rejects(
    () =>
      f.actions.prepare(
        user,
        'ws-1',
        { action: 'doc.create', title: 'One too many', content: '# One too many' },
        'assistant',
      ),
    /25 actions are already waiting/,
  );
  assert.equal(f.actions.list(user, { status: 'pending' }).length, 25);
  f.db.close();
});
