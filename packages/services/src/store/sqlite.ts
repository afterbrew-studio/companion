import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

/**
 * The SQLite handle every store, migration and test in this repo talks to, over
 * Node's built-in `node:sqlite`. It exists so the daemon needs no native addon:
 * `better-sqlite3` carries an install script, which makes `npm i -g
 * @moxxy/companion` warn on every install and need a C++ toolchain wherever no
 * prebuilt binary matches.
 *
 * It is deliberately the SUBSET this repo uses, spelled the way better-sqlite3
 * spelled it, so the callers did not have to change. `iterate`, `pluck`, `raw`,
 * `bind`, `columns`, `function`, `aggregate`, `backup` and `serialize` are
 * absent because nothing calls them; `node:sqlite` has an equivalent for each
 * when something does.
 *
 * Two places where binding is NOT better-sqlite3's, because `node:sqlite` gives
 * no way to make it so: a named parameter the SQL does not declare is rejected
 * rather than ignored (loud, and the key was doing nothing), and a declared
 * parameter the caller never supplies binds NULL rather than throwing "Missing
 * named parameter" (silent: the one regression here, and unreachable from code
 * that ran under better-sqlite3, which refused to run it at all).
 */

export interface RunResult {
  readonly changes: number;
  readonly lastInsertRowid: number;
}

export interface Statement<Result = unknown> {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): Result | undefined;
  all(...params: unknown[]): Result[];
}

const OBJECT_PROTOTYPE = Object.prototype;

/**
 * `node:sqlite` returns rows with a null prototype where better-sqlite3 returns
 * plain objects, and the difference is observable: `assert.deepStrictEqual`
 * compares prototypes, and `String(row)` throws without one. Retagging in place
 * costs ~70ns a row against ~440ns for a shallow copy (measured over 200k rows),
 * and the row is ours: `node:sqlite` allocated it for this call.
 */
function plain(row: object): void {
  Object.setPrototypeOf(row, OBJECT_PROTOTYPE);
}

/**
 * better-sqlite3 binds `undefined` as NULL, `node:sqlite` refuses to bind it at
 * all, and nothing in between catches the difference: a bind parameter is typed
 * `unknown`, so an optional value reaches one without a word from TypeScript.
 * Normalising it keeps that call working instead of turning it into a runtime
 * throw in whichever branch nobody exercised.
 *
 * The rest array is this call's own, so it is fixed in place; a named-parameter
 * object belongs to the caller and is copied, but only if it holds an
 * `undefined` at all, which is the rarer case.
 */
function bindable(params: unknown[]): SQLInputValue[] {
  for (let i = 0; i < params.length; i++) if (params[i] === undefined) params[i] = null;
  const named = params[0];
  if (typeof named === 'object' && named !== null && !ArrayBuffer.isView(named)) {
    params[0] = definedValues(named as Record<string, unknown>);
  }
  return params as SQLInputValue[];
}

function definedValues(named: Record<string, unknown>): Record<string, unknown> {
  let copy: Record<string, unknown> | undefined;
  for (const key of Object.keys(named)) {
    if (named[key] === undefined) (copy ??= { ...named })[key] = null;
  }
  return copy ?? named;
}

class PreparedStatement<Result> implements Statement<Result> {
  constructor(private readonly stmt: StatementSync) {}

  run(...params: unknown[]): RunResult {
    return this.stmt.run(...bindable(params)) as RunResult;
  }

  get(...params: unknown[]): Result | undefined {
    const row = this.stmt.get(...bindable(params));
    if (row === undefined) return undefined;
    plain(row);
    return row as Result;
  }

  all(...params: unknown[]): Result[] {
    const rows = this.stmt.all(...bindable(params));
    for (const row of rows) plain(row);
    return rows as Result[];
  }
}

/** better-sqlite3 nests with one reused savepoint name, and so do we: SAVEPOINT
 *  pushes, and RELEASE / ROLLBACK TO address the most recent one of that name. */
const SAVEPOINT = 'SAVEPOINT `_companion_tx`';
const RELEASE = 'RELEASE `_companion_tx`';
const ROLLBACK_TO = 'ROLLBACK TO `_companion_tx`';

export class Database {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path, {
      // Both defaults are the better-sqlite3 ones the schema and the callers were
      // written against, and `node:sqlite` picks the opposite on both. Foreign
      // keys ON would start enforcing an ON DELETE CASCADE that has never run,
      // and a zero busy timeout turns any writer contention (the CLI's repair
      // path, a second daemon) into an immediate SQLITE_BUSY.
      enableForeignKeyConstraints: false,
      timeout: 5_000,
    });
  }

  prepare<Result = unknown>(sql: string): Statement<Result> {
    return new PreparedStatement<Result>(this.db.prepare(sql));
  }

  exec(sql: string): this {
    this.db.exec(sql);
    return this;
  }

  /** The rows the pragma returns, as better-sqlite3's `pragma()` did. */
  pragma(source: string): unknown[] {
    return this.prepare(`PRAGMA ${source}`).all();
  }

  /**
   * Runs `fn` inside a transaction and returns a callable, as better-sqlite3
   * does: the work commits when `fn` returns, rolls back when it throws, and a
   * call made while a transaction is already open nests through a savepoint
   * instead of failing. The rollback is what the 14 call sites and every
   * migration depend on.
   */
  transaction<Args extends unknown[], Result>(fn: (...args: Args) => Result): (...args: Args) => Result {
    return (...args: Args): Result => {
      const nested = this.db.isTransaction;
      this.db.exec(nested ? SAVEPOINT : 'BEGIN');
      try {
        const result = fn(...args);
        this.db.exec(nested ? RELEASE : 'COMMIT');
        return result;
      } catch (err) {
        // `fn` may have ended the transaction itself (SQLite rolls back on some
        // errors, and nothing stops a caller running ROLLBACK); undoing a second
        // time would throw over the error that actually matters.
        if (this.db.isTransaction) {
          this.db.exec(nested ? ROLLBACK_TO : 'ROLLBACK');
          if (nested) this.db.exec(RELEASE);
        }
        throw err;
      }
    };
  }

  close(): void {
    this.db.close();
  }
}
