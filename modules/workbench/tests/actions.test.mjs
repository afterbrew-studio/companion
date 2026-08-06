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
      'issue-triage.apply',
      'issue-triage.dismiss',
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
  const domain = { discards: 0 };
  let run = {
    id: 'run-1',
    repo: 'acme/app',
    title: 'Implement search',
    status: 'review',
    updatedAt: 10,
  };
  let pr = overrides.pr ?? null;
  const workspace = {
    requireAccessible: (_user, id) => assert.equal(id, 'ws-1'),
    canAccessWorkspace: () => true,
    canAccessRepo: () => true,
  };
  const operate = { requireRunAccess: () => run };
  const code = {
    repos: { inWorkspace: () => true },
    githubAccounts: { permissionFor: async () => ({ accountId: 'gh-1' }) },
    fixes: {
      approve: async () => ({ prUrl: 'https://github.test/acme/app/pull/1' }),
      discard: async () => {
        domain.discards += 1;
      },
    },
    prs: { get: () => pr },
    prReviews: {},
    issues: { get: () => null },
    triage: {},
    sync: {},
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
