import assert from 'node:assert/strict';
import test from 'node:test';
import { Database } from '@moxxy/companion-services';
import migrations from '../dist/api/migrations.js';
import { WorkspacesStore } from '../dist/api/workspaces-store.js';
import { ReportsStore } from '../dist/api/reports-store.js';
import routeFactory from '../dist/api/routes.js';

const ana = { username: 'ana', displayName: 'Ana', role: 'user' };

/**
 * The reports route over a real store and schema. `code` simulates
 * `ctx.services.tryGet('code')`; the default stub grants every repo credential
 * so the SQL access scope is what the test observes.
 */
function fixture() {
  const db = new Database(':memory:');
  for (const m of migrations) m.up(db);
  db.exec(`CREATE TABLE users (username TEXT PRIMARY KEY, display_name TEXT)`);
  const workspaces = new WorkspacesStore(db);
  workspaces.ensureDefault();
  workspaces.insert({ id: 'ws-pub', name: 'Public', slug: 'pub', description: '' });
  workspaces.insert({ id: 'ws-priv', name: 'Private', slug: 'priv', description: '', visibility: 'private', ownerId: 'bob' });
  const reports = new ReportsStore(db);
  const services = { workspace: workspaces, core: {}, notifications: {}, reports };
  const code = {
    repos: { listByWorkspace: () => [] },
    githubAccounts: { verifiedClientFor: async () => ({ client: {} }) },
  };
  const routes = routeFactory({
    services: { get: (id) => services[id], tryGet: (id) => (id === 'code' ? code : undefined) },
    rbac: { allows: () => true },
    broadcast: () => {},
  });
  const listReports = (user, cursor) => {
    const target = routes.find((c) => c.method === 'GET' && c.path === '/api/reports');
    const query = new URLSearchParams();
    if (cursor) {
      query.set('before', String(cursor.createdAt));
      query.set('beforeId', cursor.id);
    }
    return target.run({}, query, {}, user, null, '127.0.0.1');
  };
  const seed = (id, workspaceId, createdAt, kind = 'digest') =>
    reports.insert({ id, workspaceId, repo: null, issueNumber: null, kind, title: id, body: '', createdAt });
  return { db, reports, listReports, seed };
}

test('a viewer whose visible reports are older than the newest 100 still gets them', async () => {
  const fx = fixture();
  // 120 newer rows ana cannot see (private workspace she is not in) ...
  for (let i = 0; i < 120; i += 1) fx.seed(`priv-${String(i).padStart(3, '0')}`, 'ws-priv', 2_000_000 + i);
  // ... burying 5 older rows she can.
  for (let i = 0; i < 5; i += 1) fx.seed(`pub-${i}`, 'ws-pub', 1_000_000 + i);

  const { reports, nextCursor } = await fx.listReports(ana);
  assert.deepEqual(
    reports.map((r) => r.id),
    ['pub-4', 'pub-3', 'pub-2', 'pub-1', 'pub-0'],
  );
  assert.equal(nextCursor, null);
  fx.db.close();
});

test('the cursor pages the visible feed without skips or duplicates', async () => {
  const fx = fixture();
  for (let i = 0; i < 230; i += 1) fx.seed(`pub-${String(i).padStart(3, '0')}`, 'ws-pub', 1_000_000);

  const seen = [];
  let cursor;
  for (;;) {
    const { reports, nextCursor } = await fx.listReports(ana, cursor);
    seen.push(...reports.map((r) => r.id));
    if (!nextCursor) break;
    cursor = nextCursor;
  }
  assert.equal(seen.length, 230);
  assert.equal(new Set(seen).size, 230);
  fx.db.close();
});

test('unscoped legacy briefings stay hidden; instance-wide rows show for everyone', async () => {
  const fx = fixture();
  fx.seed('legacy-briefing', null, 3_000_000, 'briefing');
  fx.seed('instance-wide', null, 3_000_001);

  const { reports } = await fx.listReports(ana);
  assert.deepEqual(reports.map((r) => r.id), ['instance-wide']);
  fx.db.close();
});

test('repo-scoped legacy rows follow their repo workspace visibility', async () => {
  const fx = fixture();
  fx.db.exec(`
    CREATE VIEW v_repos (full_name, workspace_id) AS
      SELECT 'acme/open', 'ws-pub' UNION ALL SELECT 'acme/hidden', 'ws-priv'
  `);
  const seedRepo = (id, repo) =>
    fx.reports.insert({ id, workspaceId: null, repo, issueNumber: null, kind: 'ci-analysis', title: id, body: '', createdAt: 5_000_000 });
  seedRepo('repo-visible', 'acme/open');
  seedRepo('repo-hidden', 'acme/hidden');

  const { reports } = await fx.listReports(ana);
  assert.deepEqual(reports.map((r) => r.id), ['repo-visible']);
  fx.db.close();
});

test('report prune is bounded per sweep and converges across runs', () => {
  const fx = fixture();
  const OLD = Date.now() - 400 * 24 * 60 * 60_000;
  for (let i = 0; i < 5; i += 1) fx.seed(`old-${i}`, 'ws-pub', OLD + i);
  fx.seed('fresh', 'ws-pub', Date.now());

  assert.equal(fx.reports.prune(365 * 24 * 60 * 60_000, 2), 2);
  assert.equal(fx.reports.prune(365 * 24 * 60 * 60_000, 2), 2);
  assert.equal(fx.reports.prune(365 * 24 * 60 * 60_000, 2), 1);
  assert.equal(fx.reports.prune(365 * 24 * 60 * 60_000, 2), 0);
  assert.deepEqual(fx.reports.list().map((r) => r.id), ['fresh']);
  fx.db.close();
});
