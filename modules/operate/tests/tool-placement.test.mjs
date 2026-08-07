import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import migrations from '../dist/api/migrations.js';
import { OperateStore } from '../dist/api/operate-store.js';
import { Runners } from '../dist/api/runners-registry.js';
import { LOCAL_RUNNER_ID } from '../dist/api/runners-store.js';

process.env.COMPANION_HOME = mkdtempSync(join(tmpdir(), 'companion-tool-placement-'));

const SINK = {
  onEvent() {},
  onTurnComplete() {},
  onAsk() {},
  onAskResolved() {},
  onGone() {},
  onRunnerUnreachable() {},
};

function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  for (const m of migrations) m.up(db);
  const settings = {
    get: (key) => db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key)?.value ?? null,
    set: (key, value) => db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(key, value),
  };
  return new OperateStore(db, settings);
}

function addMachine(store, id, name, patch = {}) {
  store.runners.insert({
    id,
    name,
    kind: 'remote',
    endpoint: null,
    token: null,
    scope: 'shared',
    ownerId: null,
    maxRuns: 3,
    workspaceIds: [],
    ...patch,
  });
}

/**
 * Every machine answers "yes, I have it" and reads as online, so the only thing
 * that can keep one out of the result is the policy under test.
 */
function registry(store) {
  const runners = new Runners(store, {}, null, 3, SINK, () => {});
  runners.setToolProbes(() => [{ id: 'coderabbit.cli', binaries: ['cr'] }]);
  for (const row of store.runners.list()) {
    runners.health.set(row.id, {
      status: 'online',
      runtimes: [],
      liveRuns: 0,
      maxRuns: 3,
      lastSeenAt: Date.now(),
      detail: null,
    });
    runners.tools.set(row.id, {
      at: Date.now(),
      list: [{ id: 'coderabbit.cli', binary: 'cr', version: '0.7.2', present: true, detail: null }],
    });
  }
  return runners;
}

const names = (machines) => machines.map((m) => m.runnerId ?? LOCAL_RUNNER_ID);

test("a tool never reaches another user's personal machine", async () => {
  const store = fixture();
  addMachine(store, 'runner-bob', "bob's laptop", { ownerId: 'bob' });
  addMachine(store, 'runner-shared', 'shared box');
  const runners = registry(store);

  const forAlice = await runners.machinesWithTool('coderabbit.cli', { repo: 'acme/app', userId: 'alice' });

  assert.ok(!names(forAlice).includes('runner-bob'), "alice's review must not run on bob's laptop");
  assert.ok(names(forAlice).includes('runner-shared'));

  // Bob's own work still reaches it, and prefers it over the shared machine.
  const forBob = await runners.machinesWithTool('coderabbit.cli', { repo: 'acme/app', userId: 'bob' });
  assert.equal(names(forBob)[0], 'runner-bob');
});

test('a machine cleared for selected repositories is not given another one', async () => {
  const store = fixture();
  addMachine(store, 'runner-fenced', 'fenced box');
  store.runners.update('runner-fenced', { repoScope: 'selected', repoIds: ['acme/allowed'] });
  const runners = registry(store);

  assert.deepEqual(
    names(await runners.machinesWithTool('coderabbit.cli', { repo: 'acme/other', userId: 'alice' })),
    [LOCAL_RUNNER_ID],
  );
  assert.ok(
    names(await runners.machinesWithTool('coderabbit.cli', { repo: 'acme/allowed', userId: 'alice' })).includes(
      'runner-fenced',
    ),
  );
});

test('a disabled machine is never chosen for a tool', async () => {
  const store = fixture();
  addMachine(store, 'runner-off', 'switched off');
  store.runners.update('runner-off', { enabled: false });
  const runners = registry(store);

  assert.ok(
    !names(await runners.machinesWithTool('coderabbit.cli', { repo: 'acme/app', userId: 'alice' })).includes(
      'runner-off',
    ),
  );
});

test('a machine that does not have the tool is left out entirely', async () => {
  const store = fixture();
  addMachine(store, 'runner-bare', 'bare box');
  const runners = registry(store);
  runners.tools.set('runner-bare', {
    at: Date.now(),
    list: [{ id: 'coderabbit.cli', binary: null, version: null, present: false, detail: null }],
  });

  assert.deepEqual(
    names(await runners.machinesWithTool('coderabbit.cli', { repo: 'acme/app', userId: 'alice' })),
    [LOCAL_RUNNER_ID],
  );
});

test('the daemon machine is offered last, and a busier machine after an idle one', async () => {
  const store = fixture();
  addMachine(store, 'runner-busy', 'busy box');
  addMachine(store, 'runner-idle', 'idle box');
  const runners = registry(store);
  runners.health.set('runner-busy', { ...runners.health.get('runner-busy'), liveTools: 2 });

  assert.deepEqual(names(await runners.machinesWithTool('coderabbit.cli', { repo: 'acme/app', userId: 'alice' })), [
    'runner-idle',
    'runner-busy',
    LOCAL_RUNNER_ID,
  ]);
});
