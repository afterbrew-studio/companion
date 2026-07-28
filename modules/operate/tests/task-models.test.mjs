import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import migrations from '../dist/api/migrations.js';
import { OperateStore } from '../dist/api/operate-store.js';
import { Orchestrator } from '../dist/api/orchestrator.js';
import { Runners } from '../dist/api/runners-registry.js';
import { LOCAL_RUNNER_ID } from '../dist/api/runners-store.js';

// Provider names configured in the daemon's own moxxy home leak into the merged
// catalog; point it at an empty dir so these tests see only seeded catalogs.
process.env.COMPANION_HOME = mkdtempSync(join(tmpdir(), 'companion-task-models-'));

const CONFIG = { host: '127.0.0.1', port: 8902, maxLiveRuns: 3, defaultModel: 'opus' };

const SINK = {
  onEvent() {},
  onTurnComplete() {},
  onAsk() {},
  onAskResolved() {},
  onGone() {},
  onRunnerUnreachable() {},
};

const provider = (name, models, ready = true) => ({
  name,
  enabled: true,
  ready,
  models: models.map((id) => ({ id, contextWindow: null })),
});

const catalogOf = (...providers) => ({
  providers,
  defaultModel: providers[0]?.models[0]?.id ?? null,
  fetchedAt: Date.now(),
});

function seededStore() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  for (const m of migrations) m.up(db);
  return new OperateStore(db, {
    get: (key) => db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key)?.value ?? null,
    set: (key, value) => db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(key, value),
  });
}

/** Remote rows with no endpoint build no backend, so nothing opens a socket. */
function addMachine(store, id, name, ownerId = null) {
  store.runners.insert({
    id,
    name,
    kind: 'remote',
    endpoint: null,
    token: null,
    scope: 'shared',
    ownerId,
    maxRuns: 3,
    workspaceIds: [],
  });
}

/**
 * An orchestrator whose local backend is stubbed at the process boundary: runs
 * are created and prompted without spawning a real moxxy gateway. `dispatched`
 * captures what the turn was actually asked to run on: the end of the model
 * cascade, observed where it lands.
 */
const oneMachineServingEverything = (store) =>
  store.runners.setCatalog(LOCAL_RUNNER_ID, catalogOf(provider('anthropic', ['opus', 'sonnet', 'haiku'])));

function fixture(seed = oneMachineServingEverything) {
  const store = seededStore();
  seed(store);
  const orchestrator = new Orchestrator(store, CONFIG, {}, null, () => {});
  const dispatched = [];
  const local = orchestrator.runners.localBackend;
  local.scratchDir = async (runId) => join(process.env.COMPANION_HOME, runId);
  local.spawn = async () => {};
  local.stop = async () => {};
  local.isLive = () => true;
  local.runTurn = async (runId, args) => {
    dispatched.push({ runId, model: args.model ?? null });
    return { turnId: `turn-${runId}` };
  };
  return { store, orchestrator, dispatched };
}

const modelOf = (dispatched, runId) => dispatched.find((d) => d.runId === runId)?.model ?? null;

test('the model cascade is explicit choice, then the task pin, then the instance default', async () => {
  const { orchestrator, dispatched } = fixture();
  orchestrator.setTaskModelPin('code.fix', 'sonnet');

  const pinned = await orchestrator.createRun({ kind: 'fix', task: 'code.fix' });
  const explicit = await orchestrator.createRun({ kind: 'fix', task: 'code.fix', model: 'haiku' });
  const unpinned = await orchestrator.createRun({ kind: 'implement', task: 'code.implement' });
  const untasked = await orchestrator.createRun({ kind: 'analysis' });

  // The row records the choice; null means nobody chose and the default applies.
  assert.equal(pinned.model, 'sonnet');
  assert.equal(explicit.model, 'haiku');
  assert.equal(unpinned.model, null);
  assert.equal(untasked.model, null);

  for (const run of [pinned, explicit, unpinned, untasked]) {
    await orchestrator.sendPrompt(run.id, 'go');
  }
  assert.equal(modelOf(dispatched, pinned.id), 'sonnet');
  assert.equal(modelOf(dispatched, explicit.id), 'haiku');
  // One task's pin is not another's: both of these ride the daemon default.
  assert.equal(modelOf(dispatched, unpinned.id), 'opus');
  assert.equal(modelOf(dispatched, untasked.id), 'opus');
});

test('a task pin no machine may serve falls back, while a fresh choice is refused', async () => {
  const { orchestrator, dispatched } = fixture();
  orchestrator.setTaskModelPin('code.fix', 'sonnet');
  orchestrator.runners.setProviderPolicy(LOCAL_RUNNER_ID, { disabledProviders: [], disabledModels: ['sonnet'] });

  // A pin is a standing preference, not a choice a user just made: it gives way
  // to the default rather than failing every run of the task.
  const run = await orchestrator.createRun({ kind: 'fix', task: 'code.fix' });
  assert.equal(run.model, null);
  await orchestrator.sendPrompt(run.id, 'go');
  assert.equal(modelOf(dispatched, run.id), 'opus');
  // Nothing was rewritten: allow the model again and the pin is back in force.
  assert.equal(orchestrator.taskModelPin('code.fix'), 'sonnet');
  orchestrator.runners.setProviderPolicy(LOCAL_RUNNER_ID, { disabledProviders: [], disabledModels: [] });
  assert.equal((await orchestrator.createRun({ kind: 'fix', task: 'code.fix' })).model, 'sonnet');

  // The same model asked for explicitly still refuses rather than substituting.
  orchestrator.runners.setProviderPolicy(LOCAL_RUNNER_ID, { disabledProviders: [], disabledModels: ['sonnet'] });
  await assert.rejects(
    () => orchestrator.createRun({ kind: 'fix', task: 'code.fix', model: 'sonnet' }),
    /no runner may use sonnet/,
  );
});

test('a pin the machine the run landed on cannot serve gives way to its default', async () => {
  // Only the shared gpu-box serves sonnet, and it refuses this task, so
  // placement can only choose the local machine. The pin is offerable (some
  // shared machine does serve it) but unusable where the work actually lands.
  const { store, orchestrator, dispatched } = fixture((store) => {
    addMachine(store, 'runner-b', 'gpu-box');
    store.runners.setCatalog(LOCAL_RUNNER_ID, catalogOf(provider('anthropic', ['opus'])));
    store.runners.setCatalog('runner-b', catalogOf(provider('anthropic', ['opus', 'sonnet'])));
  });
  orchestrator.setTaskModelPin('code.fix', 'sonnet');
  await orchestrator.runners.update('runner-b', { blockedTasks: ['code.fix'] });
  assert.ok(orchestrator.runners.servableModels().some((m) => m.id === 'sonnet'));

  const run = await orchestrator.createRun({ kind: 'fix', task: 'code.fix' });
  assert.equal(run.runnerId, null);
  // Binding the run to sonnet here would fail its every turn, so the standing
  // preference gives way rather than the run dying after its worktree exists.
  assert.equal(run.model, null);
  await orchestrator.sendPrompt(run.id, 'go');
  assert.equal(modelOf(dispatched, run.id), 'opus');
  assert.equal(orchestrator.taskModelPin('code.fix'), 'sonnet');

  // The same pin still applies on a machine that can serve it: narrowing is per
  // placement, not a global drop.
  const onGpuBox = await orchestrator.createRun({ kind: 'fix', task: 'code.fix', runnerId: 'runner-b' });
  assert.equal(onGpuBox.model, 'sonnet');
  assert.equal(store.runs.get(onGpuBox.id).model, 'sonnet');
});

test('only models an enabled machine can serve are offered as a pin', async () => {
  const store = seededStore();
  addMachine(store, 'runner-b', 'gpu-box');
  store.runners.setCatalog(LOCAL_RUNNER_ID, catalogOf(provider('anthropic', ['opus', 'sonnet'])));
  store.runners.setCatalog('runner-b', catalogOf(provider('bedrock', ['opus', 'titan'])));
  const runners = new Runners(store, {}, null, 3, SINK, () => {});

  // One entry per model id however many providers or machines list it, and it
  // carries every machine that can serve it, not just the last one seen.
  assert.deepEqual(
    runners.servableModels().map((m) => m.id),
    ['opus', 'sonnet', 'titan'],
  );
  assert.deepEqual(
    [...runners.servableModels().find((m) => m.id === 'opus').machines].sort(),
    ['runner-b', LOCAL_RUNNER_ID].sort(),
  );

  // A machine out of the pool takes its exclusive models with it, while a model
  // another machine still serves stays offerable.
  await runners.update('runner-b', { enabled: false });
  assert.deepEqual(
    runners.servableModels().map((m) => m.id),
    ['opus', 'sonnet'],
  );

  // Switched off everywhere it is served: offering it would pin work to a model
  // that silently falls back on every run.
  runners.setProviderPolicy(LOCAL_RUNNER_ID, { disabledProviders: [], disabledModels: ['sonnet'] });
  assert.deepEqual(
    runners.servableModels().map((m) => m.id),
    ['opus'],
  );
});

test('a personal machine never widens what may become instance policy', () => {
  const store = seededStore();
  addMachine(store, 'runner-ana', 'ana-laptop', 'ana');
  addMachine(store, 'runner-shared', 'build-box');
  store.runners.setCatalog(LOCAL_RUNNER_ID, catalogOf(provider('anthropic', ['opus'])));
  store.runners.setCatalog('runner-ana', catalogOf(provider('openai', ['gpt'])));
  store.runners.setCatalog('runner-shared', catalogOf(provider('mistral', ['large'])));
  const runners = new Runners(store, {}, null, 3, SINK, () => {});

  // Unattended work only ever places on the shared pool, so only the shared
  // pool's models can be pinned to a task.
  assert.deepEqual(
    runners.servableModels().map((m) => m.id),
    ['large', 'opus'],
  );
});

// ---------- upgrade: pins move off kinds and off machines ----------

function upgradeFrom(seed) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  for (const m of migrations.filter((x) => x.version < 6)) m.up(db);
  seed(db);
  for (const m of migrations) m.up(db);
  return db;
}

const pin = (db, task) => db.prepare(`SELECT value FROM settings WHERE key = ?`).get(`modelPin:task:${task}`)?.value;

function addLegacyMachine(db, id, modelPins = {}) {
  db.prepare(
    `INSERT INTO runners (id, name, kind, scope, max_runs, enabled, model_pins, created_at)
     VALUES (?, ?, 'remote', 'shared', 3, 1, ?, 0)`,
  ).run(id, id, JSON.stringify(modelPins));
}

test('an instance-wide kind pin lands on every task that ran as that kind', () => {
  const db = upgradeFrom((db) => {
    const set = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`);
    set.run('modelPin:analysis', 'sonnet');
    set.run('modelPin:fix', 'haiku');
    set.run('modelPin:report', '  ');
  });

  assert.equal(pin(db, 'code.fix'), 'haiku');
  for (const task of ['code.pr-review', 'plan.analyses', 'slop.detect', 'playground.run']) {
    assert.equal(pin(db, task), 'sonnet');
  }
  // A blank pin was "unpinned", and unpinned stays unpinned.
  assert.equal(pin(db, 'automations.digest'), undefined);
  // Kinds nobody pinned leave their tasks alone.
  assert.equal(pin(db, 'operate.chat'), undefined);

  // Re-running must neither throw nor resurrect a pin the user has since
  // cleared (the settings row is emptied, not deleted).
  db.prepare(`UPDATE settings SET value = '' WHERE key = 'modelPin:task:code.fix'`).run();
  for (const m of migrations) m.up(db);
  assert.equal(pin(db, 'code.fix'), '');
});

test("a lone machine's pins become the instance's; a fleet's stay where they are", () => {
  const single = upgradeFrom((db) => addLegacyMachine(db, LOCAL_RUNNER_ID, { fix: 'haiku', analysis: 'sonnet' }));
  assert.equal(pin(single, 'code.fix'), 'haiku');
  assert.equal(pin(single, 'refinement.analyses'), 'sonnet');

  // With more than one machine, a pin was genuinely machine-scoped: promoting
  // one machine's preference would change work that never ran there.
  const fleet = upgradeFrom((db) => {
    addLegacyMachine(db, LOCAL_RUNNER_ID, { fix: 'haiku' });
    addLegacyMachine(db, 'runner-b', { fix: 'sonnet' });
  });
  assert.equal(pin(fleet, 'code.fix'), undefined);
  // Left intact in the column, so nothing is lost and a rollback still reads it.
  assert.equal(
    fleet.prepare(`SELECT model_pins FROM runners WHERE id = ?`).get(LOCAL_RUNNER_ID).model_pins,
    JSON.stringify({ fix: 'haiku' }),
  );
});

test('the instance-wide pin outranks the machine it was set alongside', () => {
  const db = upgradeFrom((db) => {
    db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run('modelPin:fix', 'opus');
    addLegacyMachine(db, LOCAL_RUNNER_ID, { fix: 'haiku', triage: 'sonnet' });
  });

  assert.equal(pin(db, 'code.fix'), 'opus');
  // The machine still fills in where the instance said nothing.
  assert.equal(pin(db, 'code.triage'), 'sonnet');
});
