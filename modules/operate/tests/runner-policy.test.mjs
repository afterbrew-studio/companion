import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import migrations from '../dist/api/migrations.js';
import { OperateStore } from '../dist/api/operate-store.js';
import { Orchestrator } from '../dist/api/orchestrator.js';
import { LOCAL_RUNNER_ID } from '../dist/api/runners-store.js';

process.env.COMPANION_HOME = mkdtempSync(join(tmpdir(), 'companion-runner-policy-'));

const CONFIG = { host: '127.0.0.1', port: 8903, maxLiveRuns: 3 };
const PROVIDERS = [
  { name: 'anthropic', enabled: true, ready: true, models: [{ id: 'opus', contextWindow: null }] },
];

const deny = (...tasks) => ({ mode: 'deny', modules: [], tasks });
const allow = (tasks = [], modules = []) => ({ mode: 'allow', modules, tasks });

/**
 * A machine that answers like a healthy agent without a socket, installed at
 * the RunnerBackend seam the registry already treats local and remote through.
 * A remote row with no endpoint builds no backend of its own, so this is the
 * only thing standing between the fixture and a real network call — and
 * `bringOnline` asserts it took, so a rename can't quietly make every machine
 * unreachable and pass the negative tests for the wrong reason.
 */
function fakeBackend(id) {
  const live = new Set();
  return {
    id,
    probe: async () => ({
      status: 'online',
      runtimes: [{ id: 'test', label: 'Test', version: '9.9.9', state: 'ready', detail: null }],
      liveRuns: live.size,
      maxRuns: 3,
      lastSeenAt: Date.now(),
      detail: null,
      providers: PROVIDERS.map((p) => p.name),
    }),
    probeRuntime: async () => ({
      activeProvider: 'anthropic',
      providers: PROVIDERS,
      readyProviders: PROVIDERS.map((p) => p.name),
    }),
    spawn: async (runId) => void live.add(runId),
    stop: async (runId) => void live.delete(runId),
    isLive: (runId) => live.has(runId),
    liveIds: () => [...live],
    scratchDir: async (runId) => join(process.env.COMPANION_HOME, id, runId),
    sessionInfo: async () => ({
      activeProvider: 'anthropic',
      providers: PROVIDERS,
      readyProviders: PROVIDERS.map((p) => p.name),
    }),
    runTurn: async () => ({ turnId: 'turn' }),
    cleanupStorage: async () => ({
      removedWorktrees: 0,
      removedScratchDirs: 0,
      removedSessionFiles: 0,
      removedRunConfigs: 0,
      errors: [],
    }),
  };
}

function seededStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  for (const m of migrations) m.up(db);
  return new OperateStore(db, {
    get: (key) => db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key)?.value ?? null,
    set: (key, value) => db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(key, value),
  });
}

/**
 * Two machines by default — the daemon's own plus a remote one that is really
 * online. A single-machine fixture cannot tell "the policy sent it elsewhere"
 * from "there was nowhere else to go", which is how a task filter can pass its
 * whole suite while doing nothing.
 */
async function fixture({ config = {}, roles = {}, machines = ['runner-b'], db = new Database(':memory:') } = {}) {
  const store = seededStore(db);
  for (const id of machines) {
    if (store.runners.get(id)) continue;
    store.runners.insert({
      id,
      name: id,
      kind: 'remote',
      endpoint: null,
      token: null,
      scope: 'shared',
      ownerId: null,
      maxRuns: 3,
      workspaceIds: [],
    });
  }
  const orchestrator = new Orchestrator(
    store,
    CONFIG,
    {},
    null,
    () => {},
    () => 'gh-token',
    { values: () => config, get: (key) => config[key] ?? null },
    (username) => roles[username] ?? null,
  );
  const local = orchestrator.runners.localBackend;
  local.scratchDir = async (runId) => join(process.env.COMPANION_HOME, runId);
  local.spawn = async () => {};
  local.stop = async () => {};
  local.isLive = () => true;
  local.runTurn = async () => ({ turnId: 'turn' });
  // The free catalog top-up createRun does off a just-spawned gateway. There is
  // no real one here, so this answers instead of reaching for it.
  local.sessionInfo = async () => null;
  for (const id of machines) await bringOnline(orchestrator.runners, id);
  return { store, orchestrator, place: (task, opts = {}) => orchestrator.placeRun(opts.repo ?? null, { task, ...opts }) };
}

async function bringOnline(runners, id) {
  runners.backends.set(id, fakeBackend(id));
  await runners.probeNow(id);
  assert.equal(runners.healthFor(id).status, 'online', `${id} did not come online — the fixture cannot place remotely`);
}

const policyOf = (store, id) => {
  const row = store.runners.get(id);
  return { mode: row.task_policy_mode, modules: row.policy_modules, tasks: row.policy_tasks };
};

// ---------- the fixture's own control ----------

test('work the daemon machine refuses lands on a machine that accepts it', async () => {
  const { orchestrator, place } = await fixture();
  await orchestrator.runners.update(LOCAL_RUNNER_ID, { taskPolicy: deny('board.worker') });

  // Without this passing, every "it was not placed there" below could just be
  // an unreachable machine.
  assert.equal(place('board.worker'), 'runner-b');
  assert.equal(place('code.fix'), null, 'an unfiltered task still prefers the local machine');
});

// ---------- allow vs deny: what a future module update inherits ----------

test('a deny-list machine takes work registered after the list was written', async () => {
  const { orchestrator, place } = await fixture();
  await orchestrator.runners.update(LOCAL_RUNNER_ID, { taskPolicy: deny('board.worker') });
  await orchestrator.runners.update('runner-b', { taskPolicy: deny('board.worker') });

  // Nobody mentioned this task; a deny-list is open, so it runs anywhere.
  assert.equal(place('newmodule.brand-new'), null);
});

test('an allow-list machine refuses work registered after the list was written', async () => {
  const { orchestrator, place } = await fixture({ config: { unplacedWork: 'local' } });
  await orchestrator.runners.update('runner-b', { taskPolicy: allow(['code.fix']) });
  await orchestrator.runners.update(LOCAL_RUNNER_ID, { taskPolicy: deny('code.fix') });

  assert.equal(place('code.fix'), 'runner-b');
  // The machine was told it does exactly one thing. A module update that adds
  // a task must not quietly widen that.
  assert.equal(place('newmodule.brand-new'), null);
});

test('a module entry covers work that module adds later, task entries do not', async () => {
  const { orchestrator, place } = await fixture({ config: { unplacedWork: 'local' } });
  await orchestrator.runners.update(LOCAL_RUNNER_ID, { taskPolicy: allow() });
  await orchestrator.runners.update('runner-b', { taskPolicy: allow([], ['code']) });

  assert.equal(place('code.fix'), 'runner-b');
  // The whole point of the module level: it is not sugar for today's task ids.
  assert.equal(place('code.some-future-task'), 'runner-b');
  assert.equal(place('board.worker'), null, 'another module is still outside the list');
});

test('per-task granularity stays reachable underneath a module', async () => {
  const { orchestrator, place } = await fixture({ config: { unplacedWork: 'local' } });
  await orchestrator.runners.update(LOCAL_RUNNER_ID, { taskPolicy: allow() });
  // "implements but does not review" — the reason `code` cannot only be a
  // module-level switch.
  await orchestrator.runners.update('runner-b', { taskPolicy: allow(['code.implement', 'code.fix']) });

  assert.equal(place('code.implement'), 'runner-b');
  assert.equal(place('code.fix'), 'runner-b');
  assert.equal(place('code.pr-review'), null);
});

// ---------- the local-runner fallback ----------

test('a deny-list instance keeps the daemon machine as the last resort', async () => {
  const { store, orchestrator, place } = await fixture();
  await orchestrator.runners.update('runner-b', { taskPolicy: deny('board.worker') });

  // Local blocks nothing, so the pre-policy behaviour is unchanged: work no
  // other machine takes still lands here.
  assert.equal(place('board.worker'), null);

  // And still does with every slot here already taken — the last resort
  // overcommits rather than dropping the work, exactly as it did before
  // policies had a mode. This is the path the default has to keep open.
  await orchestrator.runners.update(LOCAL_RUNNER_ID, { maxRuns: 1 });
  addRunningChat(store, 'busy', null);
  assert.equal(place('board.worker'), null);
});

test('under an allow-list the daemon machine refuses instead of absorbing the work', async () => {
  const { orchestrator, place } = await fixture();
  await orchestrator.runners.update(LOCAL_RUNNER_ID, { taskPolicy: allow(['operate.chat']) });
  await orchestrator.runners.update('runner-b', { taskPolicy: allow(['code.fix']) });

  assert.equal(place('code.fix'), 'runner-b');
  assert.equal(place('operate.chat'), null);
  // The hole this closes: nobody permitted board.worker anywhere, and the old
  // last resort put it on the one machine the policy was written to protect.
  assert.throws(() => place('board.worker'), /no machine's task policy accepts board.worker/);
  // The refusal names the policy that produced it and how to change it.
  assert.throws(() => place('board.worker'), /allow-list/);
  assert.throws(() => place('board.worker'), /work no machine accepts/);
});

test('the fallback is a policy: an instance can still force the work here, or refuse always', async () => {
  const forced = await fixture({ config: { unplacedWork: 'local' } });
  await forced.orchestrator.runners.update(LOCAL_RUNNER_ID, { taskPolicy: allow() });
  await forced.orchestrator.runners.update('runner-b', { taskPolicy: allow() });
  assert.equal(forced.place('board.worker'), null);

  const strict = await fixture({ config: { unplacedWork: 'refuse' } });
  // Deny-mode everywhere, so the policies accept it — only the fallback refuses,
  // and it says so rather than blaming a task policy.
  await strict.orchestrator.runners.update(LOCAL_RUNNER_ID, { enabled: false });
  await strict.orchestrator.runners.update('runner-b', { taskPolicy: deny('board.worker') });
  assert.throws(() => strict.place('board.worker'), /does not fall back to the daemon's machine/);
});

test('a refused run fails before it exists, naming the policy', async () => {
  const { orchestrator, store } = await fixture();
  await orchestrator.runners.update(LOCAL_RUNNER_ID, { taskPolicy: allow() });
  await orchestrator.runners.update('runner-b', { taskPolicy: allow() });

  await assert.rejects(
    () => orchestrator.createRun({ kind: 'implement', task: 'board.worker' }),
    /no machine's task policy accepts board.worker/,
  );
  // No half-created run row, and nothing was quietly parked on this machine.
  assert.deepEqual(store.runs.list(), []);
});

test('saturation and refusal are different answers to hasFreeCapacity', async () => {
  const { store, orchestrator } = await fixture();
  await orchestrator.runners.update(LOCAL_RUNNER_ID, { taskPolicy: allow(['operate.chat']) });
  await orchestrator.runners.update('runner-b', { taskPolicy: allow(['operate.chat']) });

  // Work no policy accepts is not a capacity answer: reporting "no slots" would
  // park it in a queue that never clears (the board holds such a card in Ready
  // forever), so the caller is told to proceed and meets the explicit refusal
  // from placement instead.
  assert.equal(orchestrator.runners.hasFreeCapacity(null, 'board.worker'), true);
  assert.equal(orchestrator.runners.hasFreeCapacity(null, 'operate.chat'), true);

  // Genuine saturation still reports false.
  await orchestrator.runners.update(LOCAL_RUNNER_ID, { maxRuns: 1 });
  await orchestrator.runners.update('runner-b', { maxRuns: 1 });
  addRunningChat(store, 'run-1', null);
  addRunningChat(store, 'run-2', 'runner-b');
  assert.equal(orchestrator.runners.hasFreeCapacity(null, 'operate.chat'), false);
});

function addRunningChat(store, id, runnerId) {
  const now = Date.now();
  store.runs.insert({
    id,
    kind: 'interactive',
    status: 'running',
    title: 'chat',
    cwd: '/tmp',
    repo: null,
    issueNumber: null,
    proposalId: null,
    branch: null,
    prUrl: null,
    model: null,
    runnerId,
    userId: null,
    task: null,
    harness: 'moxxy',
    createdAt: now,
    updatedAt: now,
    inputTokens: 0,
    outputTokens: 0,
    outcome: null,
  });
}

test('a chat parked outside the chat pool does not eat the chat pool', async () => {
  const { store, orchestrator } = await fixture();
  // runner-b takes fix runs only, so its slots are not chat capacity — but a
  // chat can still be sitting on it (the assistant pins some there).
  await orchestrator.runners.update('runner-b', { taskPolicy: allow(['code.fix']) });
  await orchestrator.runners.update(LOCAL_RUNNER_ID, { maxRuns: 1 });
  addRunningChat(store, 'parked', 'runner-b');

  // The gate compares against task-filtered capacity, so it must count against
  // the same filtered pool — otherwise a chat outside the pool blocks the one
  // machine that does take chats.
  const chat = await orchestrator.createRun({ kind: 'interactive', task: 'operate.chat' });
  assert.equal(chat.runnerId, null);
});

// ---------- repository clearance ----------

test('a machine cleared for repositories takes only their work', async () => {
  const { orchestrator, place } = await fixture({ machines: ['runner-b', 'runner-c'] });
  // The daemon machine wins every tie, so it steps out of the pool to make the
  // routing between the two cleared machines observable at all.
  await orchestrator.runners.update(LOCAL_RUNNER_ID, { enabled: false });
  await orchestrator.runners.update('runner-b', { repoScope: 'selected', repoIds: ['acme/one'] });
  await orchestrator.runners.update('runner-c', { repoScope: 'selected', repoIds: ['acme/two'] });

  assert.equal(place('code.fix', { repo: 'acme/one', userId: 'ana' }), 'runner-b');
  assert.equal(place('code.fix', { repo: 'acme/two', userId: 'ana' }), 'runner-c');
  // Repo-less work has no clearance to match, so a cleared machine is not it.
  assert.throws(() => place('code.fix'), /no machine takes work that belongs to no repository/);

  // Widening the clearance is enough; nothing else about the machine changed.
  await orchestrator.runners.update('runner-b', { repoIds: ['acme/one', 'acme/two'] });
  assert.equal(place('code.fix', { repo: 'acme/two', userId: 'ana' }), 'runner-b');
});

test('clearing a machine for all repositories forgets the list it had', async () => {
  const { store, orchestrator } = await fixture();
  await orchestrator.runners.update('runner-b', { repoScope: 'selected', repoIds: ['acme/one'] });
  assert.deepEqual(orchestrator.runners.get('runner-b').repoIds, ['acme/one']);

  await orchestrator.runners.update('runner-b', { repoScope: 'all', repoIds: [] });
  assert.deepEqual(store.runners.get('runner-b').repo_ids, []);
});

// ---------- who may use the machine ----------

test('a shared machine can serve only selected roles, and never automation', async () => {
  const { orchestrator, place } = await fixture({
    machines: ['runner-b', 'runner-c'],
    roles: { ana: 'admin', bo: 'maintainer' },
  });
  await orchestrator.runners.update(LOCAL_RUNNER_ID, { enabled: false });
  await orchestrator.runners.update('runner-b', { allowedRoles: ['admin'] });
  await orchestrator.runners.update('runner-c', { allowedRoles: ['maintainer'] });

  assert.equal(place('code.fix', { userId: 'ana' }), 'runner-b');
  assert.equal(place('code.fix', { userId: 'bo' }), 'runner-c');
  // Unattended work has no triggering role at all, so "only these roles" must
  // not turn out to be quietly wider than it reads.
  assert.throws(() => place('code.fix', { userId: null }), /no machine accepts automated work/);

  // Empty means every role again, automation included.
  await orchestrator.runners.update('runner-c', { allowedRoles: [] });
  assert.equal(place('code.fix', { userId: null }), 'runner-c');
});

test('a role fence narrows the capacity its users schedule against', async () => {
  const { orchestrator } = await fixture({ roles: { ana: 'admin', bo: 'maintainer' } });
  const before = orchestrator.runners.totalCapacity('bo');
  await orchestrator.runners.update('runner-b', { allowedRoles: ['admin'] });

  assert.equal(orchestrator.runners.totalCapacity('ana'), before);
  assert.equal(orchestrator.runners.totalCapacity('bo'), before - 3);
});

// ---------- upgrade: the block-list becomes a policy ----------

test('an existing block-list migrates to a deny policy with the same entries', async () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  for (const m of migrations.filter((x) => x.version < 7)) m.up(db);
  const legacy = db.prepare(
    `INSERT INTO runners (id, name, kind, scope, max_runs, enabled, blocked_tasks, created_at)
     VALUES (?, ?, ?, 'shared', 3, 1, ?, 0)`,
  );
  legacy.run(LOCAL_RUNNER_ID, 'This machine', 'local', JSON.stringify(['operate.chat']));
  legacy.run('runner-b', 'gpu-box', 'remote', JSON.stringify(['board.worker']));
  legacy.run('runner-c', 'spare', 'remote', null);

  for (const m of migrations) m.up(db);
  const store = seededStore(db);

  assert.deepEqual(policyOf(store, LOCAL_RUNNER_ID), { mode: 'deny', modules: [], tasks: ['operate.chat'] });
  assert.deepEqual(policyOf(store, 'runner-b'), { mode: 'deny', modules: [], tasks: ['board.worker'] });
  assert.deepEqual(policyOf(store, 'runner-c'), { mode: 'deny', modules: [], tasks: [] });
  // Nothing was destroyed: a rollback still finds the column it came from.
  assert.equal(
    db.prepare(`SELECT blocked_tasks FROM runners WHERE id = ?`).get('runner-b').blocked_tasks,
    JSON.stringify(['board.worker']),
  );

  // Re-running must not undo an operator who has since moved to an allow-list.
  store.runners.update('runner-b', { taskPolicy: allow(['code.fix']) });
  for (const m of migrations) m.up(db);
  assert.deepEqual(policyOf(store, 'runner-b'), { mode: 'allow', modules: [], tasks: ['code.fix'] });
});

test('a migrated block-list places exactly as it used to', async () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  for (const m of migrations.filter((x) => x.version < 7)) m.up(db);
  db.prepare(
    `INSERT INTO runners (id, name, kind, scope, max_runs, enabled, blocked_tasks, created_at)
     VALUES (?, ?, 'remote', 'shared', 3, 1, ?, 0)`,
  ).run('runner-b', 'gpu-box', JSON.stringify(['board.worker']));

  const { orchestrator, place } = await fixture({ db });
  // Out of the pool, so what the migrated machine accepts is observable rather
  // than hidden behind the daemon machine winning every tie.
  await orchestrator.runners.update(LOCAL_RUNNER_ID, { enabled: false });

  assert.equal(place('code.fix'), 'runner-b', 'everything else is still open by default');
  assert.throws(() => place('board.worker'), /board\.worker/, 'still refused on the machine that blocked it');
});

// ---------- the catalog top-up is best effort, including its failures ----------

test('a catalog top-up cannot fail the run it rides along with', async () => {
  const { orchestrator } = await fixture();
  // What the local backend really does. `sessionInfo` is declared to return a
  // promise, but reaches the gateway through a lookup that raises when the run
  // has none, so the promise never exists and `.catch` never attaches.
  orchestrator.runners.backends.set(LOCAL_RUNNER_ID, {
    ...orchestrator.runners.localBackend,
    sessionInfo() {
      throw new Error('run r1 has no live gateway (resume it first)');
    },
  });

  assert.doesNotThrow(() => orchestrator.runners.noteLiveSession(null, 'r1'));
});
