import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import migrations from '../dist/api/migrations.js';
import { NotifyStore } from '../dist/api/notify-store.js';

function store(t) {
  const dir = mkdtempSync(join(tmpdir(), 'companion-notify-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new Database(join(dir, 'test.db'));
  for (const m of migrations) m.up(db);
  return new NotifyStore(db);
}

let seq = 0;
function channel(s, over = {}) {
  const id = `nc-${++seq}`;
  s.insert({
    id,
    workspaceId: null,
    userId: null,
    kind: 'webhook',
    name: id,
    url: 'https://example.test/hook',
    secret: null,
    kinds: [],
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  });
  return id;
}

const names = (targets) => targets.map((t) => t.name).sort();

test('a workspace-wide event reaches the shared channel', (t) => {
  const s = store(t);
  const shared = channel(s);
  assert.deepEqual(names(s.targetsFor(null, null)), [shared]);
});

test("a personal channel does NOT receive everyone's work", (t) => {
  // The entire point of per-recipient routing. A personal destination that also
  // took workspace-wide traffic would be the firehose this replaces.
  const s = store(t);
  channel(s, { userId: 'ana' });
  assert.deepEqual(s.targetsFor(null, null), []);
});

test('an addressed event reaches only that person’s channel', (t) => {
  const s = store(t);
  channel(s);
  const anas = channel(s, { userId: 'ana' });
  channel(s, { userId: 'bob' });
  assert.deepEqual(names(s.targetsFor(null, 'ana')), [anas]);
});

test('an addressed event does not fall back to the shared channel', (t) => {
  // Otherwise "tell Ana" would also tell the team, and the two settings would be
  // indistinguishable in practice.
  const s = store(t);
  channel(s);
  assert.deepEqual(s.targetsFor(null, 'ana'), []);
});

test('a person with no channel simply gets nothing, rather than an error', (t) => {
  const s = store(t);
  channel(s, { userId: 'bob' });
  assert.deepEqual(s.targetsFor(null, 'ana'), []);
});

// ---------- workspace scoping still applies on top ----------

test('a workspace channel takes its own workspace and the instance-wide one does too', (t) => {
  const s = store(t);
  const any = channel(s, { workspaceId: null });
  const ws1 = channel(s, { workspaceId: 'ws1' });
  channel(s, { workspaceId: 'ws2' });
  assert.deepEqual(names(s.targetsFor('ws1', null)), [any, ws1].sort());
});

test('an instance-wide event does not leak into one team’s channel', (t) => {
  const s = store(t);
  const any = channel(s, { workspaceId: null });
  channel(s, { workspaceId: 'ws1' });
  assert.deepEqual(names(s.targetsFor(null, null)), [any]);
});

test('recipient and workspace compose rather than override', (t) => {
  const s = store(t);
  const mine = channel(s, { userId: 'ana', workspaceId: 'ws1' });
  channel(s, { userId: 'ana', workspaceId: 'ws2' });
  channel(s, { userId: 'bob', workspaceId: 'ws1' });
  assert.deepEqual(names(s.targetsFor('ws1', 'ana')), [mine]);
});

test('a disabled channel is never a target, however well it matches', (t) => {
  const s = store(t);
  channel(s, { userId: 'ana', enabled: false });
  assert.deepEqual(s.targetsFor(null, 'ana'), []);
});
