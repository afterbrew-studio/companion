import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import { NotificationsStore } from '../dist/api/notifications-store.js';

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE notifications (
      id TEXT PRIMARY KEY, workspace_id TEXT, repo TEXT, kind TEXT NOT NULL,
      title TEXT NOT NULL, body TEXT NOT NULL, href TEXT, user_id TEXT,
      read_at INTEGER, created_at INTEGER NOT NULL
    );
    CREATE TABLE notification_reads (
      notification_id TEXT NOT NULL, username TEXT NOT NULL, read_at INTEGER NOT NULL,
      PRIMARY KEY (notification_id, username)
    );
  `);
  return { db, store: new NotificationsStore(db) };
}

test('notification pages are stable, personal, and do not hit SQLite variable ceilings', () => {
  const { db, store } = fixture();
  const insert = db.prepare(`
    INSERT INTO notifications
      (id, workspace_id, repo, kind, title, body, href, user_id, read_at, created_at)
    VALUES (?, 'ws-1', 'owner/repo', 'info', 'title', '', NULL, ?, NULL, ?)
  `);
  const expected = [];
  db.transaction(() => {
    for (let i = 0; i < 1505; i += 1) {
      const id = `n-${String(i).padStart(4, '0')}`;
      const recipient = i % 3 === 0 ? 'bob' : i % 3 === 1 ? 'alice' : null;
      insert.run(id, recipient, 1_000_000);
      if (recipient !== 'bob') expected.push(id);
    }
  })();
  expected.sort().reverse();

  const seen = [];
  let before;
  for (;;) {
    const page = store.list(null, 127, undefined, 'alice', before);
    if (page.length === 0) break;
    seen.push(...page.map((item) => item.id));
    if (page.length < 127) break;
    const last = page.at(-1);
    before = { createdAt: last.createdAt, id: last.id };
  }

  assert.deepEqual(seen, expected);
  assert.equal(new Set(seen).size, seen.length);
  store.markManyRead(seen, 'alice');
  const hydrated = store.list(null, 2_000, undefined, 'alice');
  assert.equal(hydrated.length, expected.length);
  assert.equal(hydrated.every((item) => item.readAt !== null), true);
  db.close();
});
