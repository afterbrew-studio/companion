import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import { DeskService } from '../dist/api/desk-service.js';
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
    async sendToRun(_user, id, text) {
      this.sends.push({ id, text });
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
  const code = { repos: { getInWorkspace: (repo, workspaceId) => (
    workspaceId === 'ws-1' && repo === 'acme/app' ? {} : null
  ) } };
  const service = new DeskService(new MissionsStore(db), assistant, workspace, code, () => {});
  return { db, assistant, service };
}

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
