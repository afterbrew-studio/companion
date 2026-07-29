import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import migrations from '../dist/api/migrations.js';
import { OperateStore } from '../dist/api/operate-store.js';
import { Orchestrator } from '../dist/api/orchestrator.js';
import { describeHarness, HARNESSES, MOXXY_HARNESS } from '../dist/api/harnesses.js';
import { rowToRun } from '../dist/api/runs-store.js';
import { LOCAL_RUNNER_ID } from '../dist/api/runners-store.js';
import { servesProviderModels, unmeteredHarnesses } from '../dist/contract/index.js';

/**
 * Companion asks the harness what it can do instead of assuming moxxy's
 * answers. These cover the asking, not the rendering: what a descriptor claims,
 * what the two predicates decide from a mixed set, and that the answer reaches
 * both places a page reads it from (a run, and a machine).
 *
 * The predicates are quantified differently on purpose, and that is the part
 * worth pinning: a ceiling is wrong if ANY runtime is unmetered, while provider
 * controls are worth showing if ANY runtime uses them.
 */

process.env.COMPANION_HOME = mkdtempSync(join(tmpdir(), 'companion-harness-caps-'));

const CONFIG = { host: '127.0.0.1', port: 8901, maxLiveRuns: 3, defaultModel: 'opus' };

const harness = (id, capabilities) => ({ id, label: id, capabilities });

const CAPS = {
  moxxyish: { approvals: 'interactive', usage: 'tokens', models: 'providers' },
  builtin: { approvals: 'policy', usage: 'cost', models: 'builtin' },
  unmetered: { approvals: 'policy', usage: 'none', models: 'builtin' },
};

function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  for (const m of migrations) m.up(db);
  const store = new OperateStore(db, {
    get: (key) => db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key)?.value ?? null,
    set: (key, value) => db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(key, value),
  });
  return { db, store, orchestrator: new Orchestrator(store, CONFIG, {}, null, () => {}) };
}

function addRun(store, id, harnessId) {
  const now = Date.now();
  store.runs.insert({
    id,
    kind: 'interactive',
    status: 'idle',
    title: 'chat',
    cwd: '/tmp',
    repo: null,
    issueNumber: null,
    proposalId: null,
    branch: null,
    prUrl: null,
    model: null,
    runnerId: null,
    userId: null,
    task: null,
    harness: harnessId,
    createdAt: now,
    updatedAt: now,
    inputTokens: 0,
    outputTokens: 0,
    outcome: null,
  });
}

// ---------- what the predicates decide -------------------------------------

test('a ceiling is blind to any runtime that reports nothing, not only to all of them', () => {
  // The mixed set is the case that matters: work still gets metered, so a
  // predicate that answered "some harness reports usage" would call this fine
  // and let the operator read an under-counted total as being under budget.
  const mixed = [harness('a', CAPS.moxxyish), harness('b', CAPS.unmetered)];
  assert.deepEqual(
    unmeteredHarnesses(mixed).map((h) => h.id),
    ['b'],
  );
  assert.deepEqual(unmeteredHarnesses([harness('a', CAPS.moxxyish)]), []);
  assert.deepEqual(unmeteredHarnesses([]), []);
});

test('reporting cost counts as reporting: only "none" blinds the ceiling', () => {
  assert.deepEqual(unmeteredHarnesses([harness('b', CAPS.builtin)]), []);
});

test('provider controls survive one provider-sourced runtime beside a built-in one', () => {
  // The opposite quantifier: its models are still the operator's to allow, so
  // hiding the controls because a neighbour brings its own would take away a
  // real setting.
  assert.equal(servesProviderModels([harness('a', CAPS.moxxyish), harness('b', CAPS.builtin)]), true);
  assert.equal(servesProviderModels([harness('b', CAPS.builtin)]), false);
  assert.equal(servesProviderModels([harness('b', CAPS.unmetered)]), false);
  assert.equal(servesProviderModels([]), false);
});

// ---------- what a harness id resolves to ----------------------------------

test('moxxy is described by the declaration its own client makes', async () => {
  const { MOXXY_CAPABILITIES } = await import('../dist/exec/gateway-client.js');
  assert.equal(describeHarness('moxxy'), MOXXY_HARNESS);
  assert.equal(MOXXY_HARNESS.capabilities, MOXXY_CAPABILITIES);
});

test('a harness this build does not implement claims nothing, rather than borrowing moxxy answers', () => {
  // Substituting moxxy's declaration here would put an approval sheet on a run
  // whose harness is gone, and count its (absent) usage as metered.
  const gone = describeHarness('a-harness-that-was-removed');
  assert.equal(gone.id, 'a-harness-that-was-removed');
  assert.equal(gone.capabilities.approvals, 'policy');
  assert.equal(gone.capabilities.usage, 'none');
  assert.equal(gone.capabilities.models, 'none');
  assert.deepEqual(Object.values(gone.capabilities.sessionControls), [false, false, false, false, false]);
});

test('every registered harness has a distinct id and a label to show', () => {
  assert.equal(new Set(HARNESSES.map((h) => h.id)).size, HARNESSES.length);
  for (const h of HARNESSES) assert.ok(h.label.trim().length > 0, `${h.id} has no label`);
});

// ---------- where the answer reaches the pages -----------------------------

test('a run answers with the harness it was started under, not with the default', () => {
  const { store, orchestrator } = fixture();
  addRun(store, 'run-1', 'moxxy');
  addRun(store, 'run-2', 'a-harness-that-was-removed');

  assert.equal(orchestrator.getRun('run-1').harness.id, 'moxxy');
  assert.equal(orchestrator.getRun('run-1').harness.capabilities.approvals, 'interactive');
  assert.equal(orchestrator.getRun('run-2').harness.id, 'a-harness-that-was-removed');
  assert.equal(orchestrator.getRun('run-2').harness.capabilities.approvals, 'policy');
});

test('runs that existed before the column answer moxxy, which is what they ran on', () => {
  // The migration carried, not the mapper: every run this instance already has
  // went through moxxy, so the backfill is a fact rather than a default. Read
  // through the same mapper the pages use, since that is where a null would
  // surface.
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const at = migrations.findIndex((m) => m.name === 'runs_harness');
  assert.ok(at > 0, 'the runs_harness migration is missing');
  for (const m of migrations.slice(0, at)) m.up(db);

  const now = Date.now();
  db.prepare(
    `INSERT INTO runs (id, kind, status, title, cwd, created_at, updated_at, input_tokens, output_tokens)
     VALUES ('old-run', 'interactive', 'stopped', 'chat', '/tmp', ?, ?, 0, 0)`,
  ).run(now, now);
  migrations[at].up(db);

  assert.equal(rowToRun(db.prepare(`SELECT * FROM runs WHERE id = 'old-run'`).get(), false).harness.id, 'moxxy');
});

test('every machine reports at least one harness', () => {
  const { store, orchestrator } = fixture();
  store.runners.insert({
    id: 'runner-b',
    name: 'gpu-box',
    kind: 'remote',
    endpoint: null,
    token: null,
    scope: 'shared',
    ownerId: null,
    maxRuns: 3,
    workspaceIds: [],
  });
  // A machine that reported none would accept placements it cannot serve, and
  // every capability check over the set would silently answer "no".
  for (const runner of orchestrator.runners.list()) {
    assert.ok(runner.harnesses.length > 0, `${runner.id} reports no harness`);
  }
});

/**
 * The catalog carries the answer the Providers page reads, and it agrees with
 * the machine's own harness set.
 *
 * With moxxy the only harness, both sides are true for every machine, so this
 * cannot yet distinguish "asked" from "hardcoded to true". Choosing a second
 * harness per machine is what makes the two differ, and the test that pins the
 * wiring belongs with it.
 */
test('the provider catalog says, per machine, whether providers decide its models', () => {
  const { orchestrator } = fixture();
  const snapshot = orchestrator.runners.catalogSnapshot('opus', null);
  const local = snapshot.machines.find((m) => m.id === LOCAL_RUNNER_ID);
  assert.equal(local.providerModels, servesProviderModels(orchestrator.runners.get(LOCAL_RUNNER_ID).harnesses));
  assert.equal(local.providerModels, true);
});
