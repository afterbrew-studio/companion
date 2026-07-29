import { defineMigrations } from '@moxxy/companion-core/server';

/**
 * The tasks that were riding each run kind when pins moved off kinds, frozen
 * here on purpose: the v6 migration must keep translating the same way however
 * the live task registry evolves. A task registered later starts unpinned,
 * which is what "no pin was ever set for it" means. `board.worker` takes the
 * `implement` pin, its dominant stage, though its review/CI repairs ran as
 * `fix`.
 */
const KIND_TASKS: Readonly<Record<string, readonly string[]>> = {
  interactive: ['operate.chat'],
  assistant: ['automations.assistant'],
  triage: ['code.triage'],
  fix: ['code.fix'],
  implement: ['code.implement', 'board.worker'],
  report: ['automations.digest'],
  analysis: [
    'code.pr-review',
    'code.ci-analysis',
    'code.pipeline',
    'plan.analyses',
    'planner.analyses',
    'refinement.analyses',
    'slop.detect',
    'playground.run',
  ],
};

/**
 * v1 = idempotent adopt of today's live execution-plane shape: runs + the
 * durable run queue + runners (and their workspace delegation side table).
 * Running it against an existing DB is a no-op (`IF NOT EXISTS` + try/catch
 * ALTER); against a fresh DB it produces the current schema.
 */
export default defineMigrations([
  {
    version: 1,
    name: 'operate_init',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS runs (
          id            TEXT PRIMARY KEY,
          kind          TEXT NOT NULL,
          status        TEXT NOT NULL,
          title         TEXT NOT NULL,
          cwd           TEXT NOT NULL,
          repo          TEXT,
          issue_number  INTEGER,
          created_at    INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL,
          input_tokens  INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          outcome       TEXT,
          user_id       TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

        CREATE TABLE IF NOT EXISTS run_queue (
          id           TEXT PRIMARY KEY,
          position     INTEGER NOT NULL,
          kind         TEXT NOT NULL,
          title        TEXT NOT NULL,
          repo         TEXT,
          issue_number INTEGER,
          priority     INTEGER NOT NULL,
          resume_type  TEXT NOT NULL,
          resume_args  TEXT NOT NULL DEFAULT '{}',
          enqueued_at  INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS runners (
          id            TEXT PRIMARY KEY,
          name          TEXT NOT NULL,
          kind          TEXT NOT NULL,
          endpoint      TEXT,
          token         TEXT,
          scope         TEXT NOT NULL DEFAULT 'shared',
          max_runs      INTEGER NOT NULL DEFAULT 3,
          enabled       INTEGER NOT NULL DEFAULT 1,
          model_pins    TEXT NOT NULL DEFAULT '{}',
          catalog       TEXT,
          owner_id      TEXT,
          created_at    INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS runner_workspaces (
          runner_id    TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          PRIMARY KEY (runner_id, workspace_id)
        );
      `);
      // Additive columns on pre-existing tables (CREATE TABLE IF NOT EXISTS won't add them).
      for (const ddl of [
        `ALTER TABLE runs ADD COLUMN proposal_id TEXT`,
        `ALTER TABLE runs ADD COLUMN branch TEXT`,
        `ALTER TABLE runs ADD COLUMN pr_url TEXT`,
        `ALTER TABLE runs ADD COLUMN model TEXT`,
        `ALTER TABLE runs ADD COLUMN runner_id TEXT`,
        `ALTER TABLE runs ADD COLUMN user_id TEXT`,
        `ALTER TABLE runners ADD COLUMN model_pins TEXT NOT NULL DEFAULT '{}'`,
        `ALTER TABLE runners ADD COLUMN catalog TEXT`,
      ]) {
        try {
          db.exec(ddl);
        } catch {
          // column already exists
        }
      }
      // Backfill ownership of existing AI Help runs from the per-user run map, so
      // they become private to their owner immediately (not visible to everyone).
      try {
        db.exec(`
          UPDATE runs SET user_id = (
            SELECT substr(s.key, length('assistant:run:') + 1)
            FROM settings s WHERE s.value = runs.id AND s.key LIKE 'assistant:run:%'
          )
          WHERE kind = 'assistant' AND user_id IS NULL
            AND EXISTS (SELECT 1 FROM settings s WHERE s.value = runs.id AND s.key LIKE 'assistant:run:%')
        `);
      } catch {
        // best-effort backfill
      }
    },
    down: (db) => {
      db.exec(
        `DROP TABLE IF EXISTS runner_workspaces; DROP TABLE IF EXISTS runners; DROP TABLE IF EXISTS run_queue; DROP TABLE IF EXISTS runs;`,
      );
    },
  },
  {
    // Personal runners: the owning user (null = shared instance runner). A
    // separate version because v1 is already recorded on live installs — an
    // edited v1 body never re-runs (the ledger filters version > current).
    version: 2,
    name: 'runners_owner',
    up: (db) => {
      try {
        db.exec(`ALTER TABLE runners ADD COLUMN owner_id TEXT`);
      } catch {
        // column already exists (fresh DBs create it in v1's CREATE TABLE)
      }
    },
    down: () => {
      // SQLite can't drop columns portably; harmless to keep on rollback.
    },
  },
  {
    // Superseded by v4's per-task filter before ever shipping a UI; the column
    // stays (recorded on any DB that booted between the two) but is unread.
    version: 3,
    name: 'runners_allowed_kinds',
    up: (db) => {
      try {
        db.exec(`ALTER TABLE runners ADD COLUMN allowed_kinds TEXT`);
      } catch {
        // column already exists
      }
    },
    down: () => {
      // SQLite can't drop columns portably; harmless to keep on rollback.
    },
  },
  {
    // Per-runner task filter: JSON array of blocked RunTaskDescriptor ids
    // (e.g. 'board.worker'), NULL = blocks nothing.
    version: 4,
    name: 'runners_blocked_tasks',
    up: (db) => {
      try {
        db.exec(`ALTER TABLE runners ADD COLUMN blocked_tasks TEXT`);
      } catch {
        // column already exists
      }
    },
    down: () => {
      // SQLite can't drop columns portably; harmless to keep on rollback.
    },
  },
  {
    // Per-runner provider policy: JSON arrays of disabled provider names and
    // model ids, NULL = allows everything that machine can serve. Catalogs are
    // per machine, so the policy that hides parts of them has to be too.
    version: 5,
    name: 'runners_provider_policy',
    up: (db) => {
      for (const ddl of [
        `ALTER TABLE runners ADD COLUMN disabled_providers TEXT`,
        `ALTER TABLE runners ADD COLUMN disabled_models TEXT`,
      ]) {
        try {
          db.exec(ddl);
        } catch {
          // column already exists
        }
      }
      // Carry the superseded instance-wide lists onto every existing machine so
      // an upgrade never silently widens what agents may use. NULL means "never
      // scoped", which is what makes this safe to re-run and what leaves
      // machines added later allowing everything. The settings rows stay put:
      // unread from here on, and a rollback finds them intact.
      try {
        db.exec(`
          UPDATE runners SET
            disabled_providers = COALESCE(
              disabled_providers, (SELECT value FROM settings WHERE key = 'disabledProviders')),
            disabled_models = COALESCE(
              disabled_models, (SELECT value FROM settings WHERE key = 'disabledModels'))
          WHERE disabled_providers IS NULL OR disabled_models IS NULL
        `);
      } catch {
        // settings table absent (module-core not migrated yet): nothing to carry
      }
    },
    down: () => {
      // SQLite can't drop columns portably; harmless to keep on rollback.
    },
  },
  {
    /**
     * Model pins move from run KINDS (instance-wide) and from MACHINES
     * (`runners.model_pins`) onto registered tasks, which is the unit both
     * placement and the settings page already speak in. Both old layers are
     * read nowhere from here on; nothing is deleted, so a rollback finds them
     * intact.
     *
     * Carrying, most specific first, and never overwriting a key that exists.
     * That is what makes a re-run a no-op, and what lets a later edit stand,
     * including clearing a pin back to '':
     *  1. the instance-wide kind pin, fanned out to every task that ran as that
     *     kind (same scope in, same scope out);
     *  2. on a single-machine install only, that machine's own pins: with one
     *     machine its policy WAS the instance's. A fleet keeps its per-machine
     *     pins in the (now unread) column rather than having one machine's
     *     preference promoted over work that never ran there.
     */
    version: 6,
    name: 'task_model_pins',
    up: (db) => {
      const settings = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'`).get();
      if (!settings) return; // module-core not migrated yet: nothing to carry
      const carry = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
      const read = db.prepare(`SELECT value FROM settings WHERE key = ?`);
      const pinFor = (kind: string): string | null => {
        const row = read.get(`modelPin:${kind}`) as { value?: string } | undefined;
        const value = row?.value?.trim();
        return value ? value : null;
      };
      for (const [kind, tasks] of Object.entries(KIND_TASKS)) {
        const model = pinFor(kind);
        if (!model) continue;
        for (const task of tasks) carry.run(`modelPin:task:${task}`, model);
      }

      const machines = db.prepare(`SELECT model_pins FROM runners`).all() as Array<{ model_pins: string | null }>;
      if (machines.length !== 1) return;
      let pins: Record<string, unknown> = {};
      try {
        pins = JSON.parse(machines[0]!.model_pins || '{}') as Record<string, unknown>;
      } catch {
        return; // unparseable pins: leave the column alone rather than guess
      }
      for (const [kind, tasks] of Object.entries(KIND_TASKS)) {
        const model = pins[kind];
        if (typeof model !== 'string' || model.trim() === '') continue;
        for (const task of tasks) carry.run(`modelPin:task:${task}`, model.trim());
      }
    },
    down: () => {
      // The carried settings rows are additive and unread by older code.
    },
  },
  {
    /**
     * The workforce policy: a machine's task filter gains a MODE and a module
     * level, and placement gains repository + role reach.
     *
     * `blocked_tasks` was deny-only, i.e. open by default. It carries over
     * verbatim into `mode = 'deny'` with the same ids, which is the same
     * decision expressed in the new shape — a machine that blocked nothing
     * still takes everything, and one that blocked `board.worker` still
     * refuses exactly that. The old column keeps its value and is unread from
     * here on, so a rollback finds it intact (same discipline as v5/v6).
     */
    version: 7,
    name: 'runners_workforce_policy',
    up: (db) => {
      for (const ddl of [
        `ALTER TABLE runners ADD COLUMN task_policy_mode TEXT`,
        `ALTER TABLE runners ADD COLUMN policy_modules TEXT`,
        `ALTER TABLE runners ADD COLUMN policy_tasks TEXT`,
        `ALTER TABLE runners ADD COLUMN repo_scope TEXT`,
        `ALTER TABLE runners ADD COLUMN allowed_roles TEXT`,
      ]) {
        try {
          db.exec(ddl);
        } catch {
          // column already exists
        }
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS runner_repos (
          runner_id TEXT NOT NULL,
          repo      TEXT NOT NULL,
          PRIMARY KEY (runner_id, repo)
        );
      `);
      // NULL mode means "never carried", which is what makes this re-runnable:
      // a machine an operator has since moved to an allow-list is left alone.
      db.exec(`
        UPDATE runners SET task_policy_mode = 'deny', policy_tasks = blocked_tasks
        WHERE task_policy_mode IS NULL
      `);
    },
    down: (db) => {
      // The columns stay (SQLite can't drop them portably); the side table is
      // this migration's own, and v6 has no repository reach to preserve.
      db.exec(`DROP TABLE IF EXISTS runner_repos`);
    },
  },
  {
    /**
     * Cost attribution. `kind` is too coarse to answer "what did we spend it
     * on": triage, slop detection, digests and refinement are all 'analysis'.
     * The task descriptor is the unit people already reason about (it is what
     * model pins and runner policy are expressed in), so it becomes a column
     * rather than being derived. NULL on historical rows, reported as
     * unattributed rather than bucketed into something it might not be.
     *
     * The index serves the budget gate, which sums a calendar month's spend on
     * every run creation; without it that is a full scan of a table that only
     * grows.
     */
    version: 8,
    name: 'runs_task_attribution',
    up: (db) => {
      try {
        db.exec(`ALTER TABLE runs ADD COLUMN task TEXT`);
      } catch {
        // column already exists
      }
      db.exec(`CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at)`);
    },
    down: (db) => {
      db.exec(`DROP INDEX IF EXISTS idx_runs_created_at`);
      db.exec(`ALTER TABLE runs DROP COLUMN task`);
    },
  },
  {
    /**
     * Which agent runtime a run executes through. Every run that exists when
     * this lands went through moxxy, so the default is not a guess, and it
     * keeps the column non-null for rows created by a daemon still serving the
     * previous dist.
     */
    version: 9,
    name: 'runs_harness',
    up: (db) => {
      try {
        db.exec(`ALTER TABLE runs ADD COLUMN harness TEXT NOT NULL DEFAULT 'moxxy'`);
      } catch {
        // column already exists
      }
    },
    down: (db) => {
      db.exec(`ALTER TABLE runs DROP COLUMN harness`);
    },
  },
  {
    /**
     * Which agent runtimes a machine runs work through, chosen per machine
     * because a harness is installed software and machines differ.
     *
     * NULL means "never chosen", which reads as moxxy alone: that is what every
     * existing machine ran, so an upgrade changes nothing until someone picks
     * something. Distinct from an empty list, which the write path refuses.
     */
    version: 10,
    name: 'runners_harnesses',
    up: (db) => {
      try {
        db.exec(`ALTER TABLE runners ADD COLUMN harnesses TEXT`);
      } catch {
        // column already exists
      }
    },
    down: (db) => {
      db.exec(`ALTER TABLE runners DROP COLUMN harnesses`);
    },
  },
]);
