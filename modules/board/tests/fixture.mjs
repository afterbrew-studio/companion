import Database from 'better-sqlite3';
import { BoardService } from '../dist/api/board-service.js';
import { BoardStore } from '../dist/api/board-store.js';

/**
 * A board over an in-memory schema, with the code and operate services stubbed
 * at the boundary the engine actually calls. The schema is spelled out rather
 * than migrated because the real migrations join `repos`/`repo_workspaces`,
 * which belong to another module.
 *
 * `dispatched` records every agent run the engine asked for, in the order it
 * asked, so a test can assert what a card sent to its worker without reaching
 * into the service.
 */
export function fixture({
  hasFreeCapacity = () => true,
  createGoalRun,
  startCheckFix,
  startReviewFix,
  servableModels = () => [],
  taskModelPin = () => null,
} = {}) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE board_workers (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
      role TEXT NOT NULL, enabled INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE board_tasks (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, repo TEXT NOT NULL, title TEXT NOT NULL,
      target_branch TEXT NOT NULL DEFAULT 'main',
      description TEXT NOT NULL DEFAULT '', acceptance TEXT NOT NULL DEFAULT '', spec_id TEXT,
      attachments TEXT NOT NULL DEFAULT '[]', depends_on TEXT NOT NULL DEFAULT '[]', model TEXT,
      priority INTEGER NOT NULL, status TEXT NOT NULL, stage TEXT, created_by TEXT,
      first_worker TEXT, assigned_worker_id TEXT, run_id TEXT, branch TEXT,
      pr_number INTEGER, pr_url TEXT, review_risk TEXT, review_recommendation TEXT,
      attempts INTEGER NOT NULL, last_error TEXT, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER
    );
    CREATE TABLE board_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, at INTEGER NOT NULL,
      kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE board_config (
      workspace_id TEXT PRIMARY KEY, auto_review INTEGER NOT NULL DEFAULT 1,
      reviewer_worker_id TEXT, auto_merge INTEGER NOT NULL DEFAULT 1,
      merge_method TEXT NOT NULL DEFAULT 'squash', merge_account_id TEXT,
      auto_fix_ci INTEGER NOT NULL DEFAULT 1, max_attempts INTEGER NOT NULL DEFAULT 3
    );
  `);
  const store = new BoardStore(db);
  const notifications = [];
  const dispatched = [];
  const repo = { workspace_id: 'ws-1', default_branch: 'main' };
  // Each entry point has its own signature; normalize to what the board chose,
  // so a test asserts the card's dispatch rather than an argument position.
  const record = (stage, read) => async (...args) => {
    dispatched.push({ stage, ...read(args) });
    return { id: `run-${dispatched.length}`, branch: 'task-branch' };
  };
  const fromPrBranch = ([repoName, prNumber, userId, opts = {}]) => ({
    repo: repoName,
    prNumber,
    userId,
    task: opts.task,
    preferredModel: opts.preferredModel,
  });
  const code = {
    repos: {
      get: (name) => (name === 'owner/repo' ? repo : undefined),
      inWorkspace: (name, workspaceId) => name === 'owner/repo' && workspaceId === 'ws-1',
    },
    prs: { get: () => ({ state: 'open', reviewDecision: null, checks: null }) },
    prReviews: { listForPr: () => [] },
    fixes: {
      discard: async () => undefined,
      createGoalRun:
        createGoalRun ??
        record('build', ([opts]) => ({ repo: opts.repo, userId: opts.userId, task: opts.task, preferredModel: opts.preferredModel })),
      startCheckFix: startCheckFix ?? record('fix_ci', fromPrBranch),
      startReviewFix: startReviewFix ?? record('address_review', fromPrBranch),
    },
    // The board is the pusher-of-record, so a task is held until its owner has
    // an account that can push. These tests are about what happens AFTER that
    // gate, so grant it.
    githubAccounts: { verifiedClientFor: async () => ({ client: {}, tried: [] }) },
  };
  const makeService = () => new BoardService(
    store,
    code,
    {
      runsStore: { get: () => undefined },
      runners: { hasFreeCapacity, servableModels },
      orchestrator: { taskModelPin },
    },
    { canAccessRepo: () => true },
    () => undefined,
    () => undefined,
    { emit: (notification) => notifications.push(notification) },
  );
  return { db, store, notifications, dispatched, makeService };
}

export function insertDeveloper(store) {
  store.insertWorker({
    id: 'wkr-1',
    workspaceId: 'ws-1',
    name: 'Developer',
    role: 'developer',
    enabled: true,
    createdAt: Date.now(),
  });
}

export function insertTask(store, overrides = {}) {
  const now = Date.now();
  store.insertTask({
    id: overrides.id ?? 'tsk-1',
    workspaceId: 'ws-1',
    repo: 'owner/repo',
    targetBranch: 'main',
    title: 'Lifecycle test',
    description: '',
    acceptance: '',
    specId: null,
    attachments: [],
    dependsOn: [],
    model: null,
    priority: 2,
    status: 'ready',
    stage: 'build',
    createdBy: 'owner-profile',
    firstWorker: null,
    assignedWorkerId: null,
    runId: null,
    branch: null,
    prNumber: null,
    prUrl: null,
    reviewRisk: null,
    reviewRecommendation: null,
    attempts: 0,
    lastError: null,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  });
}
