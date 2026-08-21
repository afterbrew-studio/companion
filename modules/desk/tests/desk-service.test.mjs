import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import { DeskService } from '../dist/api/desk-service.js';
import { DeskEventStateStore } from '../dist/api/event-state-store.js';
import { LaunchPlansStore } from '../dist/api/launch-plans-store.js';
import migrations from '../dist/api/migrations.js';
import { MissionsStore } from '../dist/api/missions-store.js';

const alice = { username: 'alice', displayName: 'Alice', role: 'admin' };

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function run(id, userId = 'alice') {
  return {
    id,
    kind: 'assistant',
    status: 'idle',
    title: id,
    cwd: '/tmp/desk-test',
    repo: null,
    issueNumber: null,
    proposalId: null,
    branch: null,
    prUrl: null,
    model: null,
    price: null,
    runnerId: null,
    harness: { id: 'companion', label: 'Companion', capabilities: [] },
    userId,
    task: 'desk.mission',
    verification: null,
    createdAt: 1,
    updatedAt: 1,
    live: true,
    inputTokens: 0,
    outputTokens: 0,
    outcome: null,
  };
}

function fixture() {
  const db = new Database(':memory:');
  for (const migration of migrations) migration.up(db);
  const runs = new Map();
  const notifications = [];
  const assistant = {
    creates: 0,
    lastCreateOptions: null,
    sends: [],
    createGate: null,
    sendGate: null,
    stopped: [],
    async createConversationRun(user, options) {
      this.creates += 1;
      this.lastCreateOptions = options;
      if (this.createGate) await this.createGate.promise;
      const record = run(`run-${this.creates}`, user.username);
      runs.set(record.id, record);
      return record;
    },
    async ensureConversationRun(_user, id) { return runs.get(id); },
    infoForRun(_user, id) { return { run: runs.get(id), pendingAsks: [] }; },
    async sendToRun(_user, id, text, scope) {
      this.sends.push({ id, text, scope });
      if (this.sendGate) await this.sendGate.promise;
      return { turnId: `turn-${this.sends.length}` };
    },
    async stopConversationRun(_user, id) { this.stopped.push(id); },
    async historyForRun() { return { events: [], prevCursor: null }; },
    async respondAskForRun() {},
    async abortRun() {},
  };
  const workspace = {
    canAccessWorkspace: (user) => user.username === 'alice',
    requireAccessible: (user) => {
      if (user.username !== 'alice') throw new Error('not found');
    },
    canAccessRepo: (user) => user.username === 'alice',
  };
  const code = {
    repos: {
      getInWorkspace: (repo, workspaceId) => (
        workspaceId === 'ws-1' && repo === 'acme/app' ? {} : null
      ),
      workspaceIds: (repo) => repo === 'acme/app' ? ['ws-1'] : [],
    },
    prs: {
      get: (repo, number) => repo === 'acme/app' && number === 7
        ? { repo, number, title: 'Improve search' }
        : undefined,
    },
  };
  const service = new DeskService(
    new MissionsStore(db),
    new DeskEventStateStore(db),
    new LaunchPlansStore(db),
    assistant,
    workspace,
    code,
    () => {},
    () => {},
    (input) => notifications.push(input),
  );
  return { db, assistant, notifications, service };
}

test('mission and ask events create durable-inbox inputs once per transition', async () => {
  const { db, notifications, service } = fixture();
  const mission = service.create(alice, { workspaceId: 'ws-1', repo: 'acme/app', title: 'Fix search' }).mission;
  const view = await service.session(alice, mission.id);
  const idle = run(view.mission.runId);

  service.recordRun(idle);
  service.recordRun(idle);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].kind, 'finished');
  assert.match(notifications[0].title, /Response ready/);

  service.recordRun({ ...idle, status: 'running', updatedAt: 2 });
  service.recordRun({ ...idle, status: 'idle', updatedAt: 3 });
  assert.equal(notifications.length, 2);

  const ask = { requestId: 'ask-1', workspaceId: 'ws-1', kind: 'approval', approval: { title: 'Publish patch?' } };
  service.recordAsk(idle.id, ask);
  service.recordAsk(idle.id, ask);
  assert.equal(notifications.length, 3);
  assert.equal(notifications[2].kind, 'action_required');
  assert.match(notifications[2].body, /Publish patch/);
  db.close();
});

test('check events notify only on meaningful state transitions', () => {
  const { db, notifications, service } = fixture();
  const failing = {
    checks: { state: 'failing', total: 4, passed: 3, failed: 1, pending: 0, fetchedAt: 1 },
    reviewDecision: null,
    mergeable: true,
    mergeStateStatus: 'clean',
  };
  service.recordPrStatus('acme/app', 7, failing);
  service.recordPrStatus('acme/app', 7, failing);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].kind, 'action_required');

  service.recordPrStatus('acme/app', 7, {
    ...failing,
    checks: { ...failing.checks, state: 'passing', passed: 4, failed: 0, fetchedAt: 2 },
  });
  assert.equal(notifications.length, 2);
  assert.equal(notifications[1].kind, 'finished');
  db.close();
});

test('concurrent session requests attach exactly one run to a mission', async () => {
  const { db, assistant, service } = fixture();
  const mission = service.create(alice, { workspaceId: 'ws-1', repo: 'acme/app' }).mission;
  assistant.createGate = deferred();

  const first = service.session(alice, mission.id);
  const second = service.session(alice, mission.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(assistant.creates, 1);
  assistant.createGate.resolve();

  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.mission.runId, b.mission.runId);
  assert.equal(a.mission.runId, 'run-1');
  db.close();
});

test('different missions send concurrently while one mission rejects overlapping turns', async () => {
  const { db, assistant, service } = fixture();
  const one = service.create(alice, { workspaceId: 'ws-1', repo: 'acme/app' }).mission;
  const two = service.create(alice, { workspaceId: 'ws-1', repo: 'acme/app' }).mission;
  await service.session(alice, one.id);
  await service.session(alice, two.id);
  assistant.sendGate = deferred();

  const first = service.send(alice, one.id, 'Handle the pull request');
  const parallel = service.send(alice, two.id, 'Investigate the issue');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(assistant.sends.length, 2);
  await assert.rejects(service.send(alice, one.id, 'Overlap'), /already processing/);
  assistant.sendGate.resolve();
  await Promise.all([first, parallel]);
  db.close();
});

test('mission ownership is enforced before exposing run metadata', () => {
  const { db, service } = fixture();
  const mission = service.create(alice, { workspaceId: 'ws-1' }).mission;
  assert.throws(
    () => service.get({ username: 'bob', displayName: 'Bob', role: 'maintainer' }, mission.id),
    /not found/,
  );
  db.close();
});

test('captures machine and runtime together for the mission run', async () => {
  const { db, assistant, service } = fixture();
  const view = service.create(alice, {
    workspaceId: 'ws-1',
    runnerId: 'runner-1',
    harness: 'claude-code',
  });
  assert.equal(view.mission.runnerId, 'runner-1');
  assert.equal(view.mission.harness, 'claude-code');

  await service.session(alice, view.mission.id);
  assert.equal(assistant.lastCreateOptions.runnerId, 'runner-1');
  assert.equal(assistant.lastCreateOptions.harness, 'claude-code');
  assert.throws(
    () => service.create(alice, { workspaceId: 'ws-1', runnerId: 'runner-1', harness: null }),
    /selected together/,
  );
  db.close();
});

test('refuses shelf context from another workspace', () => {
  const { db, service } = fixture();
  assert.throws(
    () => service.create(alice, {
      workspaceId: 'ws-1',
      contexts: [{ kind: 'issue', repo: 'acme/elsewhere', number: 7 }],
    }),
    /not connected to this workspace/,
  );
  db.close();
});

test('archiving during startup leaves no detached live assistant', async () => {
  const { db, assistant, service } = fixture();
  const mission = service.create(alice, { workspaceId: 'ws-1' }).mission;
  assistant.createGate = deferred();

  const starting = service.session(alice, mission.id);
  await new Promise((resolve) => setImmediate(resolve));
  service.update(alice, mission.id, { archived: true });
  assistant.createGate.resolve();

  await assert.rejects(starting, /archived missions cannot start/);
  assert.deepEqual(assistant.stopped, ['run-1']);
  assert.equal(service.get(alice, mission.id).mission.runId, null);
  db.close();
});

test('Terminal is idempotent, hidden from missions and resettable', async () => {
  const { db, assistant, service } = fixture();
  const first = service.terminal(alice, { workspaceId: 'ws-1', repo: 'acme/app' });
  const second = service.terminal(alice, { workspaceId: 'ws-1' });

  assert.equal(first.mission.id, second.mission.id);
  assert.equal(first.mission.kind, 'terminal');
  assert.equal(second.mission.repo, 'acme/app');
  assert.deepEqual(service.list(alice), []);
  assert.throws(() => service.update(alice, first.mission.id, { title: 'Not Terminal' }), /managed by Desk/);

  const active = await service.session(alice, first.mission.id);
  assert.equal(active.mission.runId, 'run-1');
  const workspaceScope = service.terminal(alice, { workspaceId: 'ws-1', repo: null });
  assert.equal(workspaceScope.mission.id, first.mission.id);
  assert.equal(workspaceScope.mission.runId, 'run-1');
  assert.equal(workspaceScope.mission.repo, null);
  service.terminal(alice, { workspaceId: 'ws-1', repo: 'acme/app' });
  await service.send(alice, first.mission.id, 'Inspect this repository');
  assert.match(assistant.sends[0].scope, /active scope is repository acme\/app/);
  assert.match(assistant.sends[0].scope, /only inside acme\/app/);
  assert.throws(
    () => service.terminal(alice, { workspaceId: 'ws-1', repo: 'acme/elsewhere' }),
    /not connected to this workspace/,
  );
  const reset = await service.resetTerminal(alice, 'ws-1');
  assert.equal(reset.mission.runId, null);
  assert.equal(reset.mission.repo, 'acme/app');
  assert.deepEqual(assistant.stopped, ['run-1']);
  db.close();
});

test('repository-scoped Terminal rejects launch plans that escape its scope', () => {
  const { db, service } = fixture();
  service.terminal(alice, { workspaceId: 'ws-1', repo: 'acme/app' });
  assert.throws(
    () => service.prepareLaunchPlan(alice, 'ws-1', [{
      title: 'Workspace audit',
      prompt: 'Inspect every repository.',
      repo: null,
      contexts: [],
    }]),
    /Terminal is scoped to acme\/app/,
  );
  db.close();
});

test('a confirmed launch plan creates and starts independent missions in parallel', async () => {
  const { db, assistant, service } = fixture();
  service.terminal(alice, { workspaceId: 'ws-1' });
  const plan = service.prepareLaunchPlan(alice, 'ws-1', [
    {
      title: 'Review PR 7',
      prompt: 'Inspect PR 7 and prepare a review.',
      repo: 'acme/app',
      contexts: [{ kind: 'pull-request', repo: 'acme/app', number: 7 }],
    },
    {
      title: 'Triage issue 8',
      prompt: 'Inspect issue 8 and propose the next action.',
      repo: 'acme/app',
      contexts: [{ kind: 'issue', repo: 'acme/app', number: 8 }],
    },
  ]);
  assistant.sendGate = deferred();

  const executing = service.executeLaunchPlan(alice, plan.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(assistant.sends.length, 2);
  assistant.sendGate.resolve();

  const completed = await executing;
  assert.equal(completed.status, 'completed');
  assert.equal(completed.missionIds.length, 2);
  assert.equal(service.list(alice).length, 2);
  db.close();
});
