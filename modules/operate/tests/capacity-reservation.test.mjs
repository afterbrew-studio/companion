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

process.env.COMPANION_HOME = mkdtempSync(join(tmpdir(), 'companion-capacity-'));

const CONFIG = { host: '127.0.0.1', port: 8917, maxLiveRuns: 3 };
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
 * (Fixture copied from runner-policy.test.mjs, which is the only suite that
 * successfully drives `placeRun`. Reproduced rather than imported because these
 * files each own their fixture; see the guard test below for why fidelity matters.)
 *
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

/**
 * Placement decides capacity from a read, and the caller creates the run afterwards.
 * Two callers that both read before either writes are both told yes.
 *
 * rayf P-0006 B2: "one atomic capacity reservation bound to runner and slot".
 *
 * Every capacity assertion below is preceded by one that the machine under test is
 * actually chosen. Without it, a machine ineligible for some unrelated reason falls
 * through to the local runner, `placeRun` returns null, and the capacity assertion
 * passes while measuring nothing. That is not hypothetical: it is how the first
 * draft of this file was wrong, in a way that read as a working test.
 */

/** Route `code.fix` to runner-b only, so the local machine cannot absorb it. */
async function onlyRunnerB(orchestrator) {
  await orchestrator.runners.update(LOCAL_RUNNER_ID, { taskPolicy: allow(['operate.chat']) });
  await orchestrator.runners.update('runner-b', { taskPolicy: allow(['code.fix']) });
}

test('guard: the fixture really places on runner-b', async () => {
  const { orchestrator, place } = await fixture();
  await onlyRunnerB(orchestrator);
  assert.equal(place('code.fix'), 'runner-b');
});

test('a machine whose runs already exist is correctly seen as full', async () => {
  // The half that works today, asserted so a later fix cannot be credited for it.
  const { store, orchestrator, place } = await fixture();
  await onlyRunnerB(orchestrator);
  await orchestrator.runners.update('runner-b', { maxRuns: 1 });
  assert.equal(place('code.fix'), 'runner-b', 'guard: placeable before the slot is taken');

  addRunningChat(store, 'occupies-the-only-slot', 'runner-b');
  assert.throws(() => place('code.fix'), /accepts|available|cleared|fall back/i);
});

// `todo`, not `skip`: it runs, it fails, and node:test reports it as a known
// defect instead of breaking the suite. A skipped test executes nothing and rots
// silently; this one will start reporting as an unexpected pass the moment
// placement begins reserving, which is the signal the fix is in.
test('two placements are handed the same single slot when neither run exists yet', { todo: 'rayf P-0006 B2 -- see afterbrew-studio/rayf#109' }, async () => {
  const { orchestrator, place } = await fixture();
  await onlyRunnerB(orchestrator);
  await orchestrator.runners.update('runner-b', { maxRuns: 1 });

  const first = place('code.fix');
  assert.equal(first, 'runner-b', 'guard: the first placement must reach runner-b');

  // Nothing created in between. That is the real interleaving: `placeRun` and run
  // creation are separate calls with async work between them.
  const second = place('code.fix');

  assert.notEqual(
    second,
    'runner-b',
    'both placements were handed the same single slot: placement reserves nothing',
  );
});
