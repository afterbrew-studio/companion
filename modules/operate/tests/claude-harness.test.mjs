import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import migrations from '../dist/api/migrations.js';
import { OperateStore } from '../dist/api/operate-store.js';
import { Orchestrator } from '../dist/api/orchestrator.js';
import { CLAUDE_CODE_HARNESS, harnessSet, MOXXY_HARNESS, offeredHarnesses } from '../dist/api/harnesses.js';
import { LocalRunnerBackend } from '../dist/api/local-backend.js';
import { LOCAL_RUNNER_ID } from '../dist/api/runners-store.js';
import { ClaudeCodeHarness, CLAUDE_CODE_CAPABILITIES, sessionUuid } from '../dist/exec/claude-code.js';
import { claudeState, moxxyState } from '../dist/exec/harness-detect.js';
import { detectProviders } from '../dist/contract/index.js';

/**
 * Choosing Claude Code on a machine, and what changes when you do.
 *
 * Nothing here spawns the CLI: every assertion is about a decision Companion
 * makes before the process starts (which runtime, on what session id, with what
 * models, and which of moxxy's affordances stop applying). The process itself is
 * exercised end to end against the real `claude` binary, which a unit test has
 * no business paying for.
 */

process.env.COMPANION_HOME = mkdtempSync(join(tmpdir(), 'companion-claude-harness-'));

const fixturesDir = join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures');

/** The orchestrator's sink, reduced to nothing: no probe here emits an event. */
const SILENT_SINK = {
  onEvent: () => undefined,
  onTurnComplete: () => undefined,
  onAsk: () => undefined,
  onAskResolved: () => undefined,
  onGone: () => undefined,
  onRunnerUnreachable: () => undefined,
};

const CONFIG = { host: '127.0.0.1', port: 8901, maxLiveRuns: 3 };

/**
 * An orchestrator over a seeded store. `seed` runs before it is constructed,
 * because the registry builds its model index there: seeding after would leave
 * the index describing a fleet that no longer exists.
 */
function fixture(seed = () => undefined) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  for (const m of migrations) m.up(db);
  const store = new OperateStore(db, {
    get: (key) => db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key)?.value ?? null,
    set: (key, value) => db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(key, value),
  });
  seed(store);
  return { db, store, orchestrator: new Orchestrator(store, CONFIG, {}, null, () => {}) };
}

/**
 * A stand-in for the CLI: it ignores the flags, optionally speaks one frame,
 * and then holds stdin open.
 *
 * `exec` matters. Without it the shell forks a reader that outlives the signal
 * sent to its parent, keeps the pipe open, and the whole test file never exits.
 * Every harness built on one registers teardown through `t.after` for the same
 * reason: a failing assertion must not leave a process behind and hang the file
 * instead of reporting the failure.
 */
function standIn(t, frame) {
  const bin = join(mkdtempSync(join(tmpdir(), 'companion-fake-claude-')), 'claude');
  const speak = frame === undefined ? '' : `cat <<'EOF'\n${frame}\nEOF\n`;
  writeFileSync(bin, `#!/bin/sh\n${speak}exec cat > /dev/null\n`, { mode: 0o755 });
  return bin;
}

/** A second machine, reachable only on paper: no endpoint, so no backend. */
function addRemote(store, id = 'runner-b') {
  store.runners.insert({
    id,
    name: 'gpu-box',
    kind: 'remote',
    endpoint: null,
    token: null,
    scope: 'shared',
    ownerId: null,
    maxRuns: 3,
    workspaceIds: [],
  });
}

const claudeCatalog = {
  providers: [
    {
      name: 'claude-code',
      enabled: true,
      ready: true,
      models: [{ id: 'sonnet', contextWindow: null }],
    },
  ],
  defaultModel: 'sonnet',
  fetchedAt: Date.now(),
};

const moxxyCatalog = {
  providers: [
    { name: 'anthropic', enabled: true, ready: true, models: [{ id: 'opus', contextWindow: null }] },
  ],
  defaultModel: 'opus',
  fetchedAt: Date.now(),
};

function addRun(store, id, harness, model = null) {
  const now = Date.now();
  store.runs.insert({
    id,
    kind: 'implement',
    status: 'running',
    title: 'work',
    cwd: '/tmp',
    repo: null,
    issueNumber: null,
    proposalId: null,
    branch: null,
    prUrl: null,
    model,
    runnerId: null,
    userId: null,
    task: null,
    harness,
    createdAt: now,
    updatedAt: now,
    inputTokens: 0,
    outputTokens: 0,
    outcome: null,
  });
}

// ---------- what Claude Code declares, against what it does -----------------

test('what it declares it cannot do is what it actually refuses', async () => {
  assert.equal(CLAUDE_CODE_CAPABILITIES.approvals, 'policy');
  assert.equal(CLAUDE_CODE_CAPABILITIES.models, 'builtin');
  assert.equal(CLAUDE_CODE_CAPABILITIES.usage, 'tokens');

  // `policy` promises no prompt will ever arrive, so answering one is an error
  // rather than a quiet success that would look like an approval landed.
  const harness = new ClaudeCodeHarness({ runId: 'run-x', cwd: '/tmp', cliPath: 'claude' }, {});
  await assert.rejects(harness.respondAsk('r1', { mode: 'allow' }), /raises no approval/);

  // Every session control is declared off, and none of them exists to be called.
  for (const [flag, method] of Object.entries({
    model: 'setModel',
    provider: 'setProvider',
    mode: 'setMode',
    autoApprove: 'setAutoApprove',
    commands: 'runCommand',
  })) {
    assert.equal(CLAUDE_CODE_CAPABILITIES.sessionControls[flag], false, `${flag} is claimed`);
    assert.equal(typeof ClaudeCodeHarness.prototype[method], 'undefined', `${method} exists`);
  }
});

test('it answers the whole contract every harness has to answer', () => {
  for (const name of ['connect', 'close', 'runTurn', 'abortTurn', 'sessionInfo', 'loadHistory', 'respondAsk']) {
    assert.equal(typeof ClaudeCodeHarness.prototype[name], 'function', `${name} is missing`);
  }
});

test('its models are its own, not a provider the operator has credentials for', async () => {
  const harness = new ClaudeCodeHarness({ runId: 'run-x', cwd: '/tmp', cliPath: 'claude' }, {});
  const info = await harness.sessionInfo();
  assert.deepEqual(info.readyProviders, ['claude-code']);
  assert.ok(info.providers[0].models.some((m) => m.id === 'fable'));
  assert.ok(info.providers[0].models.some((m) => m.id === 'sonnet'));
});

test('a session that cannot start says so, instead of reading as live', async () => {
  // There is no handshake to wait for, so "it did not die" is the readiness
  // signal. Without it the caller would be told the run started and then watch
  // it disappear, with the reason only in a log line.
  const harness = new ClaudeCodeHarness(
    { runId: 'run-missing', cwd: '/tmp', cliPath: 'claude-no-such-binary' },
    {},
  );
  await assert.rejects(harness.connect(300), /exited during startup/);
  assert.equal(harness.isOpen, false);
});

test('a turn on a session that is not running is refused rather than dropped', async () => {
  const harness = new ClaudeCodeHarness({ runId: 'run-cold', cwd: '/tmp', cliPath: 'claude' }, {});
  await assert.rejects(harness.runTurn({ prompt: 'hello' }), /is not running/);
});

test('aborting announces that the run stopped; closing does not, because the owner asked', async (t) => {
  // Aborting ends the session, and the owner learns it only from onClose. A
  // teardown that stayed quiet would leave the run reading as live forever,
  // with its dead session still held.
  const bin = standIn(t);

  const seen = [];
  const spawnOne = (id) => {
    const harness = new ClaudeCodeHarness({ runId: id, cwd: '/tmp', cliPath: bin, model: null }, {
      onClose: () => seen.push(id),
    });
    t.after(() => harness.close());
    return harness;
  };

  const aborted = spawnOne('run-abort');
  await aborted.connect(200);
  await aborted.abortTurn();
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(seen, ['run-abort']);

  const closed = spawnOne('run-close');
  await closed.connect(200);
  closed.close();
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(seen, ['run-abort']);
});

test('a resumed run comes back with its transcript, not a blank page', async (t) => {
  // The whole transcript is on disk and none of it is in the new process's
  // memory. Answering a live session from memory alone is how Stop then Resume
  // ends with an empty run detail page and no way to tell that anything was
  // lost.
  const config = mkdtempSync(join(tmpdir(), 'companion-claude-config-'));
  const runId = 'run-resumed';
  const sessionId = sessionUuid(runId);
  mkdirSync(join(config, 'projects', 'somewhere'), { recursive: true });
  // The capture was recorded under its own session id; a real file for this run
  // carries the derived one. Restamping it is what makes the replayed and the
  // live events share a session, which is the only way an id collision between
  // them is observable at all.
  writeFileSync(
    join(config, 'projects', 'somewhere', `${sessionId}.jsonl`),
    readFileSync(join(fixturesDir, 'claude-session-file.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.stringify({ ...JSON.parse(line), sessionId }))
      .join('\n'),
  );
  // One frame, so the replayed events and a genuinely new one share a transcript.
  const bin = standIn(
    t,
    JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'after-resume', content: 'ok' }] },
    }),
  );

  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  });

  const harness = new ClaudeCodeHarness({ runId, cwd: '/tmp', cliPath: bin, model: null }, {});
  t.after(() => harness.close());
  await harness.connect(400);
  // connect proves the process stayed up; it intentionally has no protocol
  // handshake. Under a busy full-suite run stdout may arrive just after that
  // settle window, so wait on the event this assertion actually needs instead
  // of treating scheduler latency as a lost transcript.
  let live = await harness.loadHistory(runId, null, 500);
  for (let attempt = 0; attempt < 40 && !live.events.some((e) => e.callId === 'after-resume'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    live = await harness.loadHistory(runId, null, 500);
  }
  assert.ok(harness.isOpen, 'the stand-in session should still be up');
  assert.ok(live.events.length > 1, 'a resumed session answered with nothing');
  assert.ok(live.events.some((e) => e.type === 'user_prompt'), 'the replayed prompts are missing');
  assert.ok(live.events.some((e) => e.callId === 'after-resume'), 'the new event never landed');

  // Numbering continues past the replay: an event from the new process must not
  // carry an id one of the replayed ones already used, or a consumer that
  // dedupes on id drops it as something the page already has.
  const ids = new Set(live.events.map((e) => e.id));
  assert.equal(ids.size, live.events.length, 'a new event reused a replayed id');
});

test('a run resumes the session it started, and never another run’s', () => {
  // The id is derived, not stored, so a daemon restart has to land on the same
  // value or the run silently starts a second conversation.
  assert.equal(sessionUuid('run-abc'), sessionUuid('run-abc'));
  assert.notEqual(sessionUuid('run-abc'), sessionUuid('run-abd'));
  assert.match(sessionUuid('run-abc'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

// ---------- choosing it on a machine ----------------------------------------

test('a stored set keeps its order: a run takes the machine’s first choice', () => {
  assert.deepEqual(harnessSet(['claude-code', 'moxxy']).map((h) => h.id), ['claude-code', 'moxxy']);
  assert.deepEqual(harnessSet(['moxxy', 'claude-code']).map((h) => h.id), ['moxxy', 'claude-code']);
});

test('an id this build cannot run is dropped, and never leaves the set empty', () => {
  assert.deepEqual(harnessSet(['opencode']).map((h) => h.id), [MOXXY_HARNESS.id]);
  assert.deepEqual(harnessSet([]).map((h) => h.id), [MOXXY_HARNESS.id]);
  assert.deepEqual(harnessSet(['opencode', 'claude-code']).map((h) => h.id), ['claude-code']);
});

test('a machine that has never been asked runs moxxy, which is what it ran before', () => {
  const { orchestrator } = fixture();
  assert.deepEqual(
    orchestrator.runners.get(LOCAL_RUNNER_ID).harnesses.map((h) => h.id),
    [MOXXY_HARNESS.id],
  );
});

test('picking a runtime on this machine is what a run started here records', async () => {
  const { store, orchestrator } = fixture();
  await orchestrator.runners.update(LOCAL_RUNNER_ID, { harnesses: ['claude-code'] });

  assert.equal(orchestrator.runners.harnessFor(LOCAL_RUNNER_ID).id, 'claude-code');
  assert.deepEqual(
    orchestrator.runners.get(LOCAL_RUNNER_ID).harnesses.map((h) => h.id),
    ['claude-code'],
  );
  // ...and the run row follows the machine, including on a failover.
  addRun(store, 'run-1', MOXXY_HARNESS.id);
  store.runs.setPlacement('run-1', LOCAL_RUNNER_ID, '/tmp/wt', orchestrator.runners.harnessFor(LOCAL_RUNNER_ID).id);
  assert.equal(orchestrator.getRun('run-1').harness.id, 'claude-code');
});

test('a machine reached over the network runs moxxy whatever its row says', () => {
  // Written straight to the row: the write path refuses this, and the read path
  // has to refuse it too, because the agent protocol carries moxxy calls only.
  const { orchestrator } = fixture((store) => {
    addRemote(store);
    store.runners.update('runner-b', { harnesses: ['claude-code'] });
  });

  assert.deepEqual(
    orchestrator.runners.get('runner-b').harnesses.map((h) => h.id),
    [MOXXY_HARNESS.id],
  );
  assert.equal(orchestrator.runners.harnessFor('runner-b').id, MOXXY_HARNESS.id);
});

// ---------- detection: three states, and what each one does -----------------

test('claude code is ready when it is signed in, and installed-not-ready when it is not', () => {
  const cli = { path: 'claude', version: '2.1.0', loggedIn: true };
  assert.equal(claudeState(cli).state, 'ready');
  assert.equal(claudeState(cli).detail, null);

  const out = claudeState({ ...cli, loggedIn: false });
  assert.equal(out.state, 'installed');
  assert.match(out.detail, /not signed in/);
  assert.equal(out.fix, 'claude auth login');

  assert.equal(claudeState(null).state, 'absent');
});

test('moxxy is not ready when it is too old, or when nothing gave it credentials', () => {
  const cli = { path: 'moxxy', version: '0.26.0', compatible: true };
  assert.equal(moxxyState(cli, ['anthropic']).state, 'ready');

  const stale = moxxyState({ ...cli, version: '0.20.0', compatible: false }, ['anthropic']);
  assert.equal(stale.state, 'installed');
  assert.equal(stale.fix, 'npm i -g @moxxy/cli@latest');

  // Installed, current, and unable to run a turn: the state that exists so an
  // instance does not look configured and fail on its first run.
  const bare = moxxyState(cli, []);
  assert.equal(bare.state, 'installed');
  assert.match(bare.detail, /provider/);

  assert.equal(moxxyState(null, ['anthropic']).state, 'absent');
});

test('a runtime that is not installed is not offered and not mentioned', () => {
  const offered = offeredHarnesses([
    { id: 'moxxy', state: 'ready', detail: null, fix: null },
    { id: 'claude-code', state: 'absent', detail: null, fix: null },
  ]);
  assert.deepEqual(offered.map((o) => o.id), ['moxxy']);
});

test('installed but not ready is offered, saying what is wrong and the one command', () => {
  const [option] = offeredHarnesses([
    { id: 'claude-code', state: 'installed', detail: 'not signed in', fix: 'claude auth login' },
  ]);
  assert.equal(option.state, 'installed');
  assert.equal(option.detail, 'not signed in');
  assert.equal(option.fix, 'claude auth login');
  assert.equal(option.label, CLAUDE_CODE_HARNESS.label);
});

test('a detected runtime this build cannot run is not offered either', () => {
  assert.deepEqual(offeredHarnesses([{ id: 'opencode', state: 'ready', detail: null, fix: null }]), []);
});

test('nothing installed is an empty list, which is the case that needs words', () => {
  assert.deepEqual(
    offeredHarnesses([
      { id: 'moxxy', state: 'absent', detail: null, fix: null },
      { id: 'claude-code', state: 'absent', detail: null, fix: null },
    ]),
    [],
  );
});

// ---------- what stops applying once a machine runs Claude Code -------------

test('a machine with its own models contributes none to the provider page', () => {
  const { orchestrator } = fixture((store) => {
    store.runners.update(LOCAL_RUNNER_ID, { harnesses: ['claude-code'] });
    store.runners.setCatalog(LOCAL_RUNNER_ID, claudeCatalog);
  });

  const snapshot = orchestrator.runners.catalogSnapshot(null);
  const machine = snapshot.machines.find((m) => m.id === LOCAL_RUNNER_ID);
  assert.equal(machine.providerModels, false);
  // Its catalog exists; it is simply not a provider catalog. Folding it in
  // would invent a provider nobody holds credentials for.
  assert.deepEqual(machine.providers, []);
  assert.deepEqual(snapshot.providers.filter((p) => p.machines.length > 0), []);
  assert.equal(detectProviders(snapshot).state, 'builtin');
});

test('a moxxy machine beside it still answers the provider question', () => {
  const { orchestrator } = fixture((store) => {
    store.runners.update(LOCAL_RUNNER_ID, { harnesses: ['claude-code'] });
    store.runners.setCatalog(LOCAL_RUNNER_ID, claudeCatalog);
    addRemote(store);
    store.runners.setCatalog('runner-b', moxxyCatalog);
  });

  const snapshot = orchestrator.runners.catalogSnapshot(null);
  assert.equal(detectProviders(snapshot).state, 'found');
  assert.equal(snapshot.machines.find((m) => m.id === 'runner-b').providerModels, true);
});

test('its models still decide placement, even though providers do not list them', () => {
  const { orchestrator } = fixture((store) => {
    store.runners.update(LOCAL_RUNNER_ID, { harnesses: ['claude-code'] });
    store.runners.setCatalog(LOCAL_RUNNER_ID, claudeCatalog);
    addRemote(store);
    store.runners.setCatalog('runner-b', moxxyCatalog);
  });

  // A model only one machine can serve must place there and nowhere else:
  // hiding a built-in runtime from the Providers page must not hide it from
  // placement. Claude Code's own models come from its descriptor, so `sonnet`
  // is the local machine's alone and the moxxy machine's `opus` is not.
  assert.equal(orchestrator.runners.serves(LOCAL_RUNNER_ID, 'sonnet'), true);
  assert.equal(orchestrator.runners.serves('runner-b', 'sonnet'), false);
  assert.equal(orchestrator.runners.serves('runner-b', 'opus'), true);
});

test('a machine set to its own models needs no probe to say what it can run', async () => {
  // Starting a process to be told a constant is the probe's whole cost for none
  // of its information, and on this path there is no process to start.
  const { store, orchestrator } = fixture();
  await orchestrator.runners.update(LOCAL_RUNNER_ID, { harnesses: ['claude-code'] });

  // Asserted through what the machine can run rather than through the stored
  // catalog: a runtime that ships its own models is merged in on read, because
  // caching something free only buys a window in which it is wrong.
  const models = orchestrator.runners.modelsForLane(LOCAL_RUNNER_ID, 'claude-code').map((m) => m.id);
  assert.deepEqual(models.sort(), ['fable', 'haiku', 'opus', 'sonnet']);
  assert.equal(orchestrator.runners.serves(LOCAL_RUNNER_ID, 'haiku'), true);
});

test('a built-in runtime session cannot replace another runtime provider catalog', () => {
  const { store, orchestrator } = fixture((seeded) => {
    seeded.runners.update(LOCAL_RUNNER_ID, { harnesses: ['moxxy', 'claude-code'] });
    seeded.runners.setCatalog(LOCAL_RUNNER_ID, { ...moxxyCatalog, fetchedAt: 0 });
  });

  orchestrator.runners.noteSessionInfo(
    null,
    {
      activeProvider: 'claude-code',
      readyProviders: ['claude-code'],
      providers: [{ name: 'claude-code', enabled: true, models: [{ id: 'fable' }] }],
    },
    'claude-code',
  );

  assert.equal(store.runners.get(LOCAL_RUNNER_ID).catalog.providers[0].name, 'anthropic');
  assert.equal(orchestrator.runners.catalogSnapshot(null).providers.some((provider) => provider.name === 'anthropic'), true);
});

/**
 * Health answers "can the runtime a run would take here actually run it", and
 * a run takes the FIRST entry and nothing else. Three ways for a machine to
 * lie, all of them a placement decision made on the wrong fact.
 */
test('health follows the runtime a run would take, not moxxy and not the whole set', async () => {
  const answers = new Map([
    ['claude-code', { id: 'claude-code', label: 'Claude Code', version: '1.0.0', state: 'ready', detail: null }],
    ['moxxy', { id: 'moxxy', label: 'Moxxy', version: '0.20.0', state: 'unavailable', detail: 'too old' }],
  ]);
  const backend = new LocalRunnerBackend(LOCAL_RUNNER_ID, {}, 'moxxy', 3, SILENT_SINK, {
    runSpec: () => ({ harness: 'moxxy', model: null }),
    harnesses: () => order,
    runtime: async (id) =>
      answers.get(id) ?? { id, label: id, version: null, state: 'unavailable', detail: 'unknown' },
  });
  let order = ['moxxy'];

  // moxxy first, and this daemon cannot use the moxxy that is here.
  assert.equal((await backend.probe()).status, 'degraded');

  // Claude Code first: a machine moved to another runtime is not degraded for
  // missing something it was told not to use.
  order = ['claude-code'];
  assert.equal((await backend.probe()).status, 'online');

  // Claude Code first with moxxy kept behind it: the fallback nothing reaches
  // must not take the whole machine offline.
  order = ['claude-code', 'moxxy'];
  assert.equal((await backend.probe()).status, 'online');

  // ...and the runtime it does take having gone away IS degraded, with a
  // reason. Reporting online here is how every run fails on a green machine.
  answers.set('claude-code', {
    id: 'claude-code',
    label: 'Claude Code',
    version: '1.0.0',
    state: 'unavailable',
    detail: 'not signed in',
  });
  const health = await backend.probe();
  assert.equal(health.status, 'degraded');
  assert.equal(health.detail, 'not signed in');
});

test('switching runtimes drops the models the previous one reported', async () => {
  // Kept, the old catalog reads as a credentialed provider the moment the
  // machine is back on moxxy, which is exactly what the switch should end.
  const { orchestrator } = fixture();
  await orchestrator.runners.update(LOCAL_RUNNER_ID, { harnesses: ['claude-code'] });
  assert.ok(orchestrator.runners.modelsForLane(LOCAL_RUNNER_ID, 'claude-code').length > 0);

  // Back to moxxy, whose probe cannot succeed here (no CLI in this fixture).
  await orchestrator.runners.update(LOCAL_RUNNER_ID, { harnesses: ['moxxy'] });
  assert.deepEqual(orchestrator.runners.modelsForLane(LOCAL_RUNNER_ID, 'moxxy'), []);
  assert.equal(orchestrator.runners.catalogSnapshot(null).providers.some((p) => p.name === 'claude-code'), false);
  assert.equal(orchestrator.runners.serves(LOCAL_RUNNER_ID, 'haiku'), true, 'an unknown model stays permissive');
});

test('goal mode is skipped on a harness with no modes, instead of failing the run', async () => {
  const { store, orchestrator } = fixture();
  addRun(store, 'run-claude', CLAUDE_CODE_HARNESS.id);
  addRun(store, 'run-moxxy', MOXXY_HARNESS.id);

  // Neither run is live. The moxxy one must still try (and say so); the Claude
  // Code one must not, because there is no mode to set and every autonomous run
  // would fail on its first call.
  await orchestrator.setGoalMode('run-claude');
  await assert.rejects(orchestrator.setGoalMode('run-moxxy'), /live gateway/);
});
