import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import migrations from '../dist/api/migrations.js';
import { WorkspacesStore } from '../dist/api/workspaces-store.js';

const DAY = 86_400_000;

/**
 * The pre-SQL metrics algorithm, verbatim: the reference the aggregated
 * queries must reproduce on the same rows.
 */
function referenceMetrics(rows, weeks = 12) {
  const { issues, prs } = rows;
  const monday = new Date();
  monday.setHours(0, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const starts = [];
  for (let i = weeks - 1; i >= 0; i--) starts.push(monday.getTime() - i * 7 * DAY);
  const bucket = (ts) => {
    if (ts === null || ts < starts[0]) return -1;
    for (let i = starts.length - 1; i >= 0; i--) if (ts >= starts[i]) return i;
    return -1;
  };
  const weekly = starts.map((weekStart) => ({ weekStart, issuesOpened: 0, issuesClosed: 0, prsOpened: 0, prsClosed: 0 }));
  for (const i of issues) {
    const opened = bucket(i.created_at);
    if (opened >= 0) weekly[opened].issuesOpened++;
    const closed = bucket(i.closed_at);
    if (closed >= 0) weekly[closed].issuesClosed++;
  }
  for (const p of prs) {
    const opened = bucket(p.created_at);
    if (opened >= 0) weekly[opened].prsOpened++;
    const closed = bucket(p.closed_at);
    if (closed >= 0) weekly[closed].prsClosed++;
  }
  const thisWeek = weekly[weekly.length - 1];
  const now = Date.now();
  const d7 = now - 7 * DAY;
  const d14 = now - 14 * DAY;
  const win = (ts, from, to) => ts !== null && ts >= from && ts < to;
  return {
    openIssues: issues.filter((i) => i.state === 'open').length,
    closedIssues: issues.filter((i) => i.state === 'closed').length,
    openPrs: prs.filter((p) => p.state === 'open').length,
    mergedPrs: prs.filter((p) => p.state === 'merged').length,
    issuesOpenedThisWeek: thisWeek.issuesOpened,
    issuesClosedThisWeek: thisWeek.issuesClosed,
    prsOpenedThisWeek: thisWeek.prsOpened,
    prsClosedThisWeek: thisWeek.prsClosed,
    issuesOpened7d: issues.filter((i) => win(i.created_at, d7, now + 1)).length,
    issuesOpenedPrev7d: issues.filter((i) => win(i.created_at, d14, d7)).length,
    issuesClosed7d: issues.filter((i) => win(i.closed_at, d7, now + 1)).length,
    issuesClosedPrev7d: issues.filter((i) => win(i.closed_at, d14, d7)).length,
    prsOpened7d: prs.filter((p) => win(p.created_at, d7, now + 1)).length,
    prsOpenedPrev7d: prs.filter((p) => win(p.created_at, d14, d7)).length,
    prsClosed7d: prs.filter((p) => win(p.closed_at, d7, now + 1)).length,
    prsClosedPrev7d: prs.filter((p) => win(p.closed_at, d14, d7)).length,
    weekly,
  };
}

function fixture() {
  const db = new Database(':memory:');
  for (const m of migrations) m.up(db);
  // Code-owned tables the metrics JOIN, minimal shape.
  db.exec(`
    CREATE TABLE issues (repo TEXT, state TEXT, created_at INTEGER, closed_at INTEGER);
    CREATE TABLE prs (repo TEXT, state TEXT, created_at INTEGER, closed_at INTEGER);
    CREATE TABLE repo_map (full_name TEXT, workspace_id TEXT);
    CREATE VIEW v_repos AS SELECT full_name, workspace_id FROM repo_map;
  `);
  const workspaces = new WorkspacesStore(db);
  workspaces.ensureDefault();
  db.prepare(`INSERT INTO repo_map VALUES ('acme/app', 'ws-default'), ('acme/lib', 'ws-default'), ('other/repo', 'ws-other')`).run();
  return { db, workspaces };
}

test('SQL-aggregated metrics match the per-row reference on a seeded fixture', () => {
  const { db, workspaces } = fixture();
  const now = Date.now();
  const insertIssue = db.prepare(`INSERT INTO issues VALUES (?, ?, ?, ?)`);
  const insertPr = db.prepare(`INSERT INTO prs VALUES (?, ?, ?, ?)`);
  const issues = [];
  const prs = [];
  // Spread across 20 weeks (some before the 12-week window), mixed states,
  // closes at varying lags, an hour clear of any week/day boundary.
  for (let i = 0; i < 200; i += 1) {
    const created = now - (i % 140) * DAY - ((i % 5) + 1) * 3_600_000;
    const closed = i % 3 === 0 ? created + (i % 10) * DAY : null;
    const repo = i % 4 === 3 ? 'other/repo' : i % 2 === 0 ? 'acme/app' : 'acme/lib';
    const issueState = closed !== null ? 'closed' : 'open';
    insertIssue.run(repo, issueState, created, closed);
    const prState = closed !== null ? (i % 6 === 0 ? 'merged' : 'closed') : 'open';
    insertPr.run(repo, prState, created, closed);
    if (repo !== 'other/repo') {
      issues.push({ state: issueState, created_at: created, closed_at: closed });
      prs.push({ state: prState, created_at: created, closed_at: closed });
    }
  }

  const actual = workspaces.metrics('ws-default');
  assert.deepEqual(actual, referenceMetrics({ issues, prs }));
  db.close();
});

test('metrics honour the accessible-repo filter and degrade without v_repos', () => {
  const { db, workspaces } = fixture();
  const now = Date.now();
  db.prepare(`INSERT INTO issues VALUES ('acme/app', 'open', ?, NULL)`).run(now - 3_600_000);
  db.prepare(`INSERT INTO issues VALUES ('acme/lib', 'open', ?, NULL)`).run(now - 3_600_000);

  assert.equal(workspaces.metrics('ws-default', 12, ['acme/app']).openIssues, 1);
  // repoNames [] means "the viewer can reach nothing": empty series, not all rows.
  assert.equal(workspaces.metrics('ws-default', 12, []).openIssues, 0);

  db.exec(`DROP VIEW v_repos`);
  const bare = workspaces.metrics('ws-default');
  assert.equal(bare.openIssues, 0);
  assert.equal(bare.weekly.length, 12);
  db.close();
});
