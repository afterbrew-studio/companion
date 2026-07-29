import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../dist/index.js';

/**
 * The handle every store, migration and test in the repo runs on. It replaced a
 * native addon, so these pin the behaviour the callers were written against and
 * that `node:sqlite` does NOT give for free: transactions that roll back and
 * nest, rows that are ordinary objects, foreign keys left off, and a journal mode
 * that is actually in effect rather than merely asked for.
 */

function withFileDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'companion-sqlite-'));
  const file = join(dir, 'companion.db');
  const db = new Database(file);
  try {
    return fn(db, file);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const rows = (db) => db.prepare('SELECT v FROM t ORDER BY v').all().map((r) => r.v);

function memoryDb() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t (v TEXT)');
  return db;
}

test('a transaction commits what its function did, and hands back what it returned', () => {
  const db = memoryDb();
  const written = db.transaction(() => {
    db.prepare('INSERT INTO t (v) VALUES (?)').run('a');
    return 'result';
  })();
  assert.equal(written, 'result');
  assert.deepEqual(rows(db), ['a']);
});

test('a transaction passes its arguments through to the function', () => {
  const db = memoryDb();
  db.transaction((values) => {
    for (const v of values) db.prepare('INSERT INTO t (v) VALUES (?)').run(v);
  })(['a', 'b']);
  assert.deepEqual(rows(db), ['a', 'b']);
});

test('a throw rolls the whole transaction back and rethrows', () => {
  const db = memoryDb();
  assert.throws(
    () =>
      db.transaction(() => {
        db.prepare('INSERT INTO t (v) VALUES (?)').run('a');
        throw new Error('halfway');
      })(),
    /halfway/,
  );
  assert.deepEqual(rows(db), []);
});

test('a rolled-back transaction leaves no transaction open: the next write commits', () => {
  // The failure this exists for: a shim that wraps BEGIN and COMMIT but does not
  // undo on a throw leaves the connection inside a transaction for good. Nothing
  // on this connection notices, but every later write is uncommitted, and a
  // second connection (the CLI's repair path) reads a database frozen in time.
  withFileDb((db, file) => {
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE t (v TEXT)');
    assert.throws(() => {
      db.transaction(() => {
        db.prepare('INSERT INTO t (v) VALUES (?)').run('rolled-back');
        throw new Error('halfway');
      })();
    }, /halfway/);

    db.prepare('INSERT INTO t (v) VALUES (?)').run('after');

    const other = new Database(file);
    try {
      assert.deepEqual(rows(other), ['after']);
    } finally {
      other.close();
    }
  });
});

test('a transaction nested in another one undoes only its own work', () => {
  const db = memoryDb();
  db.transaction(() => {
    db.prepare('INSERT INTO t (v) VALUES (?)').run('outer');
    assert.throws(
      () =>
        db.transaction(() => {
          db.prepare('INSERT INTO t (v) VALUES (?)').run('inner');
          throw new Error('inner failed');
        })(),
      /inner failed/,
    );
    db.prepare('INSERT INTO t (v) VALUES (?)').run('after-inner');
  })();
  assert.deepEqual(rows(db), ['after-inner', 'outer']);
});

test('a nested transaction that succeeded is still undone when the outer one throws', () => {
  const db = memoryDb();
  assert.throws(
    () =>
      db.transaction(() => {
        db.transaction(() => {
          db.prepare('INSERT INTO t (v) VALUES (?)').run('inner');
        })();
        throw new Error('outer failed');
      })(),
    /outer failed/,
  );
  assert.deepEqual(rows(db), []);
});

test('nesting is not one savepoint deep: three levels undo independently', () => {
  const db = memoryDb();
  db.transaction(() => {
    db.prepare('INSERT INTO t (v) VALUES (?)').run('L1');
    db.transaction(() => {
      db.prepare('INSERT INTO t (v) VALUES (?)').run('L2');
      assert.throws(() =>
        db.transaction(() => {
          db.prepare('INSERT INTO t (v) VALUES (?)').run('L3');
          throw new Error('deepest');
        })(),
      );
    })();
  })();
  assert.deepEqual(rows(db), ['L1', 'L2']);
});

test('a nested transaction that undid its work leaves the savepoint stack as it found it', () => {
  // Not visible in the rows: the same data comes out either way. What an
  // unreleased savepoint costs is stack depth, one per failed nesting, for as
  // long as the outer transaction lives. Releasing a name that is no longer on
  // the stack is an error, so that is the probe, and the one place a test has to
  // know the shim's own savepoint name.
  const db = memoryDb();
  db.transaction(() => {
    assert.throws(() => db.transaction(() => {
      throw new Error('inner');
    })(), /inner/);
    assert.throws(() => db.exec('RELEASE `_companion_tx`'), /no such savepoint/);
  })();
});

test('a transaction that already rolled itself back does not fail on the way out', () => {
  // SQLite ends the transaction itself on some errors, and a caller can run
  // ROLLBACK by hand. Undoing a second time would throw over the real error.
  const db = memoryDb();
  assert.throws(
    () =>
      db.transaction(() => {
        db.exec('ROLLBACK');
        throw new Error('original');
      })(),
    /original/,
  );
  assert.deepEqual(rows(db), []);
});

test('a migration that fails halfway leaves none of its schema behind', () => {
  const db = new Database(':memory:');
  assert.throws(() =>
    db.transaction(() => {
      db.exec('CREATE TABLE half (a TEXT)');
      db.exec('CREATE INDEX half_a ON half (a)');
      throw new Error('migration failed');
    })(),
  );
  assert.deepEqual(db.prepare(`SELECT name FROM sqlite_master WHERE name LIKE 'half%'`).all(), []);
});

test('run() reports plain numbers, as the stores that return them assume', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  const result = db.prepare('INSERT INTO t (v) VALUES (?)').run('a');
  assert.equal(result.changes, 1);
  assert.equal(typeof result.changes, 'number');
  assert.equal(result.lastInsertRowid, 1);
  assert.equal(typeof result.lastInsertRowid, 'number');
  assert.equal(db.prepare('DELETE FROM t WHERE v = ?').run('nobody').changes, 0);
});

test('rows are ordinary objects, not the null-prototype ones the driver returns', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t (a TEXT, b INTEGER)');
  db.prepare('INSERT INTO t VALUES (?, ?)').run('x', 1);
  // deepStrictEqual compares prototypes, and 244 assertions across the suites
  // spell their expectations as literals.
  assert.deepStrictEqual(db.prepare('SELECT * FROM t').get(), { a: 'x', b: 1 });
  assert.deepStrictEqual(db.prepare('SELECT * FROM t').all(), [{ a: 'x', b: 1 }]);
  assert.equal(db.prepare('SELECT * FROM t WHERE a = ?').get('nobody'), undefined);
  assert.deepStrictEqual(db.prepare('SELECT * FROM t WHERE a = ?').all('nobody'), []);
});

test('named parameters bind bare and prefixed, the way the stores write them', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t (a TEXT, b TEXT)');
  db.prepare('INSERT INTO t (a, b) VALUES (@a, @b)').run({ a: 'bare-at', b: 'b' });
  db.prepare('INSERT INTO t (a, b) VALUES (:a, :b)').run({ a: 'bare-colon', b: 'b' });
  db.prepare('INSERT INTO t (a, b) VALUES (@a, @b)').run({ '@a': 'prefixed', '@b': 'b' });
  assert.deepEqual(db.prepare('SELECT a FROM t ORDER BY a').all(), [
    { a: 'bare-at' },
    { a: 'bare-colon' },
    { a: 'prefixed' },
  ]);
});

test('undefined binds as NULL rather than failing the call', () => {
  // better-sqlite3 accepted it and a bind parameter is typed `unknown`, so
  // `undefined` reaches one without a word from TypeScript.
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t (a TEXT, b TEXT)');
  db.prepare('INSERT INTO t (a, b) VALUES (?, ?)').run('x', undefined);
  db.prepare('INSERT INTO t (a, b) VALUES (@a, @b)').run({ a: 'y', b: undefined });
  assert.deepEqual(db.prepare('SELECT a, b FROM t ORDER BY a').all(), [
    { a: 'x', b: null },
    { a: 'y', b: null },
  ]);
  assert.deepEqual(db.prepare('SELECT a FROM t WHERE b IS ?').all(undefined).length, 2);
});

test('a named-parameter object the caller reuses is not rewritten under them', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t (a TEXT, b TEXT)');
  const params = { a: 'x', b: undefined };
  db.prepare('INSERT INTO t (a, b) VALUES (@a, @b)').run(params);
  assert.deepEqual(params, { a: 'x', b: undefined });
});

test('a named parameter the SQL never declared is refused, not ignored', () => {
  // The one deliberate break with better-sqlite3, which dropped such a key
  // silently. Loud is the right side to err on: the key was doing nothing, and a
  // misspelled one is the same mistake.
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t (a TEXT)');
  assert.throws(
    () => db.prepare('INSERT INTO t (a) VALUES (@a)').run({ a: 'x', spurious: 1 }),
    /Unknown named parameter 'spurious'/,
  );
});

test('foreign keys stay off, so a schema written without them keeps its meaning', () => {
  // better-sqlite3 leaves them off and `node:sqlite` turns them on. An existing
  // database has rows that a suddenly-enforced ON DELETE CASCADE would delete.
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE parent (id TEXT PRIMARY KEY);
    CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id) ON DELETE CASCADE);
  `);
  db.prepare('INSERT INTO child (id, parent_id) VALUES (?, ?)').run('c1', 'no-such-parent');
  db.prepare('INSERT INTO parent (id) VALUES (?)').run('p1');
  db.prepare('INSERT INTO child (id, parent_id) VALUES (?, ?)').run('c2', 'p1');
  db.prepare('DELETE FROM parent WHERE id = ?').run('p1');
  assert.deepEqual(db.prepare('SELECT id FROM child ORDER BY id').all(), [{ id: 'c1' }, { id: 'c2' }]);
});

test('a writer waits for a busy database instead of failing on the spot', () => {
  const db = new Database(':memory:');
  assert.deepEqual(db.pragma('busy_timeout'), [{ timeout: 5000 }]);
});

test('WAL is in effect, not merely requested', () => {
  withFileDb((db, file) => {
    assert.deepEqual(db.pragma('journal_mode = WAL'), [{ journal_mode: 'wal' }]);
    assert.deepEqual(db.pragma('journal_mode'), [{ journal_mode: 'wal' }]);
    db.exec('CREATE TABLE t (v TEXT)');
    assert.equal(existsSync(`${file}-wal`), true);
  });
});

test('the SQLite error text a migration matches on survives', () => {
  // Two migrations decide a column is already there by matching this message.
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t (a TEXT)');
  assert.throws(() => db.exec('ALTER TABLE t ADD COLUMN a TEXT'), /duplicate column name/i);
  db.exec('CREATE TABLE u (a TEXT UNIQUE)');
  db.prepare('INSERT INTO u VALUES (?)').run('x');
  assert.throws(() => db.prepare('INSERT INTO u VALUES (?)').run('x'), /UNIQUE constraint failed/);
});
