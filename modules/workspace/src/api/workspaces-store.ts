import type { AuthUser } from '@moxxy/companion-contracts';
import { notFound, type Database } from '@moxxy/companion-sdk/server';
import type {
  WorkspaceMember,
  WorkspaceMemberRole,
  WorkspaceMetrics,
  WorkspaceRecord,
  WorkspaceVisibility,
} from '../contract/index.js';

/**
 * Workspaces group repos; the dashboard metrics roll up per workspace. This
 * store owns the access-control predicates (`canAccess`/`canAccessRepo`/
 * `accessibleIds`) — the scoping key every other module resolves
 * through. Metrics/`canAccessRepo` read code-owned tables (repos/issues/prs) by
 * design; those tables persist regardless of module-code's enabled state.
 */
export class WorkspacesStore {
  constructor(private readonly db: Database) {}

  /**
   * Every install has at least one workspace. (Orphan-repo adoption — the
   * legacy second half of this method — lives with module-code, the repos
   * owner: its table doesn't exist yet when this module constructs.)
   */
  ensureDefault(): void {
    const count = this.db.prepare(`SELECT COUNT(*) AS n FROM workspaces`).get() as { n: number };
    if (count.n === 0) {
      this.db
        .prepare(`INSERT INTO workspaces (id, name, slug, description, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run('ws-default', 'Default', 'default', 'Default workspace', Date.now());
    }
  }

  // repo_count reads code's published `v_repos` view (never its raw table); the
  // bare variant (0 repos) is the graceful fallback when module-code is
  // uninstalled and the view is gone — the REQUIRED workspace listing must never
  // crash on a missing foreign relation.
  private readonly selectFull = `SELECT w.*,
    (SELECT COUNT(*) FROM v_repos r WHERE r.workspace_id = w.id) AS repo_count,
    (SELECT COUNT(*) FROM workspace_members m WHERE m.workspace_id = w.id) AS member_count
    FROM workspaces w`;
  private readonly selectBare = `SELECT w.*, 0 AS repo_count,
    (SELECT COUNT(*) FROM workspace_members m WHERE m.workspace_id = w.id) AS member_count
    FROM workspaces w`;

  private queryWorkspaces(tail: string, ...args: unknown[]): WorkspaceRow[] {
    try {
      return this.db.prepare(`${this.selectFull} ${tail}`).all(...args) as WorkspaceRow[];
    } catch {
      return this.db.prepare(`${this.selectBare} ${tail}`).all(...args) as WorkspaceRow[];
    }
  }

  list(): WorkspaceRecord[] {
    return this.queryWorkspaces(`ORDER BY w.created_at`).map(workspaceRowToRecord);
  }

  listFor(user: AuthUser): WorkspaceRecord[] {
    return this.queryWorkspaces(
      `WHERE w.visibility = 'public'
          OR EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = w.id AND m.username = ?)
       ORDER BY w.created_at`,
      user.username,
    ).map(workspaceRowToRecord);
  }

  get(id: string): WorkspaceRecord | undefined {
    const row = this.queryWorkspaces(`WHERE w.id = ?`, id)[0];
    return row ? workspaceRowToRecord(row) : undefined;
  }

  insert(w: {
    id: string;
    name: string;
    slug: string;
    description: string;
    visibility?: WorkspaceVisibility;
    ownerId?: string | null;
  }): void {
    const visibility = w.visibility ?? 'public';
    this.db
      .prepare(
        `INSERT INTO workspaces (id, name, slug, description, visibility, owner_id, created_at)
         VALUES (@id, @name, @slug, @description, @visibility, @ownerId, @createdAt)`,
      )
      .run({
        id: w.id,
        name: w.name,
        slug: w.slug,
        description: w.description,
        visibility,
        ownerId: visibility === 'private' ? (w.ownerId ?? null) : null,
        createdAt: Date.now(),
      });
    if (visibility === 'private' && w.ownerId) this.addMember(w.id, w.ownerId, 'owner');
  }

  update(id: string, fields: { name?: string; description?: string }): void {
    this.db
      .prepare(`UPDATE workspaces SET name = COALESCE(?, name), description = COALESCE(?, description) WHERE id = ?`)
      .run(fields.name ?? null, fields.description ?? null, id);
  }

  // Owned tables only. pipelines/step_definitions are code-owned; the delete
  // route asks their owner (when present) to clean up. reports/notifications
  // are this module's own tables: rows keyed to a dead workspace id would
  // otherwise sit orphaned behind every access filter forever.
  delete(id: string): void {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM workspace_members WHERE workspace_id = ?`).run(id);
      this.db.prepare(`DELETE FROM reports WHERE workspace_id = ?`).run(id);
      this.db
        .prepare(
          `DELETE FROM notification_reads
           WHERE notification_id IN (SELECT id FROM notifications WHERE workspace_id = ?)`,
        )
        .run(id);
      this.db.prepare(`DELETE FROM notifications WHERE workspace_id = ?`).run(id);
      this.db.prepare(`DELETE FROM workspaces WHERE id = ?`).run(id);
    })();
  }

  // ---------- membership + access ----------

  members(id: string): WorkspaceMember[] {
    const rows = this.db
      .prepare(
        `SELECT m.username, m.role, COALESCE(u.display_name, '') AS display_name
         FROM workspace_members m
         LEFT JOIN users u ON u.username = m.username
         WHERE m.workspace_id = ?
         ORDER BY m.role = 'owner' DESC, m.created_at`,
      )
      .all(id) as Array<{ username: string; role: string; display_name: string }>;
    return rows.map((r) => ({
      username: r.username,
      displayName: r.display_name || r.username,
      role: r.role as WorkspaceMemberRole,
    }));
  }

  addMember(id: string, username: string, role: WorkspaceMemberRole = 'member'): void {
    this.db
      .prepare(
        `INSERT INTO workspace_members (workspace_id, username, role, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(workspace_id, username) DO UPDATE SET role = excluded.role`,
      )
      .run(id, username, role, Date.now());
  }

  removeMember(id: string, username: string): void {
    this.db.prepare(`DELETE FROM workspace_members WHERE workspace_id = ? AND username = ? AND role != 'owner'`).run(id, username);
  }

  isMember(id: string, username: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM workspace_members WHERE workspace_id = ? AND username = ?`).get(id, username);
  }

  /** Can this user see the workspace? Public: always. Private: members, regardless of platform role. */
  canAccess(user: AuthUser, ws: WorkspaceRecord): boolean {
    return ws.visibility === 'public' || this.isMember(ws.id, user.username);
  }

  /** Convenience for cross-module callers that only have the id. */
  canAccessWorkspace(user: AuthUser, id: string): boolean {
    const ws = this.get(id);
    return ws ? this.canAccess(user, ws) : false;
  }

  /**
   * The single "accessible or not-found" gate every workspace-scoped feed uses
   * (workspace + code + plan + automations routes) — a private workspace's
   * existence must read as 404 to non-members, so this hides both cases.
   */
  requireAccessible(user: AuthUser | null, id: string): WorkspaceRecord {
    const ws = this.get(id);
    if (!ws || !user || !this.canAccess(user, ws)) throw notFound(`workspace ${id} not found`);
    return ws;
  }

  setVisibility(id: string, visibility: WorkspaceVisibility, actorUsername: string): void {
    if (visibility === 'private') {
      const ws = this.get(id);
      if (ws && !ws.ownerId) {
        this.db.prepare(`UPDATE workspaces SET owner_id = ? WHERE id = ?`).run(actorUsername, id);
        this.addMember(id, actorUsername, 'owner');
      }
    }
    this.db.prepare(`UPDATE workspaces SET visibility = ? WHERE id = ?`).run(visibility, id);
  }

  private repoVisibilities(fullName: string): Array<{ id: string; visibility: string; owner_id: string | null }> {
    try {
      return this.db
        .prepare(
          `SELECT w.id, w.visibility, w.owner_id
           FROM v_repos r JOIN workspaces w ON w.id = r.workspace_id
           WHERE r.full_name = ?`,
        )
        .all(fullName) as Array<{ id: string; visibility: string; owner_id: string | null }>;
    } catch {
      // module-code (repos owner) uninstalled — its v_repos view is gone.
      return [];
    }
  }

  /** Can this user see a repo? Follows its workspace's access rule. */
  canAccessRepo(user: AuthUser, fullName: string): boolean {
    const workspaces = this.repoVisibilities(fullName);
    // Without a workspace mapping there is no scope to prove. This also keeps
    // orphaned records private if module-code (and its v_repos view) is absent.
    return workspaces.some((w) => w.visibility === 'public' || this.isMember(w.id, user.username));
  }

  /** Ids of the workspaces a user may see — for filtering global listings. */
  accessibleIds(user: AuthUser): Set<string> {
    return new Set(this.listFor(user).map((w) => w.id));
  }

  /** Published workspace projection for modules that need to scope their own rows by repo. */
  repoNames(workspaceId: string): string[] {
    try {
      return (
        this.db
          .prepare(`SELECT full_name FROM v_repos WHERE workspace_id = ? ORDER BY full_name`)
          .all(workspaceId) as Array<{ full_name: string }>
      ).map((row) => row.full_name);
    } catch {
      return [];
    }
  }

  /**
   * Counters + weekly open/close velocity for a workspace's dashboard.
   * Aggregated in SQL (GROUP BY state / week bucket): the old shape pulled
   * every issue/PR row of the workspace into JS on each dashboard view.
   */
  metrics(workspaceId: string, weeks = 12, repoNames?: readonly string[]): WorkspaceMetrics {
    const monday = new Date();
    monday.setHours(0, 0, 0, 0);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const weekMs = 7 * 86_400_000;
    const start0 = monday.getTime() - (weeks - 1) * weekMs;
    const now = Date.now();
    const d7 = now - 7 * 86_400_000;
    const d14 = now - 14 * 86_400_000;

    interface TableAgg {
      states: Map<string, number>;
      openedWeekly: number[];
      closedWeekly: number[];
      opened7d: number;
      openedPrev7d: number;
      closed7d: number;
      closedPrev7d: number;
    }
    const empty = (): TableAgg => ({
      states: new Map(),
      openedWeekly: new Array<number>(weeks).fill(0),
      closedWeekly: new Array<number>(weeks).fill(0),
      opened7d: 0,
      openedPrev7d: 0,
      closed7d: 0,
      closedPrev7d: 0,
    });

    // issues/prs are code-owned; if module-code is uninstalled the JOINs fail —
    // degrade to empty series rather than crash the dashboard.
    const aggregate = (table: 'issues' | 'prs'): TableAgg => {
      if (repoNames?.length === 0) return empty();
      const repoFilter = repoNames ? ` AND t.repo IN (${repoNames.map(() => '?').join(', ')})` : '';
      const repoArgs = repoNames ?? [];
      const scope = `FROM ${table} t JOIN v_repos r ON r.full_name = t.repo
         WHERE r.workspace_id = ?${repoFilter}`;
      try {
        const agg = empty();
        const states = this.db
          .prepare(`SELECT t.state AS state, COUNT(*) AS n ${scope} GROUP BY t.state`)
          .all(workspaceId, ...repoArgs) as Array<{ state: string; n: number }>;
        for (const row of states) agg.states.set(row.state, row.n);
        // The CAST is load-bearing (see runs usageByDay): ms timestamps bind as
        // REAL, and a real division would group fractional buckets per row.
        // MIN clamps a future timestamp into the current week, as the old
        // walk-back lookup did.
        const opened = this.db
          .prepare(
            `SELECT MIN(CAST((t.created_at - ?) / ? AS INTEGER), ?) AS bucket, COUNT(*) AS n
             ${scope} AND t.created_at >= ? GROUP BY bucket`,
          )
          .all(start0, weekMs, weeks - 1, workspaceId, ...repoArgs, start0) as Array<{ bucket: number; n: number }>;
        for (const row of opened) agg.openedWeekly[row.bucket] = row.n;
        const closed = this.db
          .prepare(
            `SELECT MIN(CAST((t.closed_at - ?) / ? AS INTEGER), ?) AS bucket, COUNT(*) AS n
             ${scope} AND t.closed_at IS NOT NULL AND t.closed_at >= ? GROUP BY bucket`,
          )
          .all(start0, weekMs, weeks - 1, workspaceId, ...repoArgs, start0) as Array<{ bucket: number; n: number }>;
        for (const row of closed) agg.closedWeekly[row.bucket] = row.n;
        const windows = this.db
          .prepare(
            `SELECT
               COALESCE(SUM(t.created_at >= ? AND t.created_at < ?), 0) AS opened7d,
               COALESCE(SUM(t.created_at >= ? AND t.created_at < ?), 0) AS openedPrev7d,
               COALESCE(SUM(t.closed_at IS NOT NULL AND t.closed_at >= ? AND t.closed_at < ?), 0) AS closed7d,
               COALESCE(SUM(t.closed_at IS NOT NULL AND t.closed_at >= ? AND t.closed_at < ?), 0) AS closedPrev7d
             ${scope}`,
          )
          .get(d7, now + 1, d14, d7, d7, now + 1, d14, d7, workspaceId, ...repoArgs) as {
          opened7d: number;
          openedPrev7d: number;
          closed7d: number;
          closedPrev7d: number;
        };
        agg.opened7d = windows.opened7d;
        agg.openedPrev7d = windows.openedPrev7d;
        agg.closed7d = windows.closed7d;
        agg.closedPrev7d = windows.closedPrev7d;
        return agg;
      } catch {
        return empty();
      }
    };

    const issues = aggregate('issues');
    const prs = aggregate('prs');
    const weekly = Array.from({ length: weeks }, (_, i) => ({
      weekStart: start0 + i * weekMs,
      issuesOpened: issues.openedWeekly[i]!,
      issuesClosed: issues.closedWeekly[i]!,
      prsOpened: prs.openedWeekly[i]!,
      prsClosed: prs.closedWeekly[i]!,
    }));
    const thisWeek = weekly[weekly.length - 1]!;

    return {
      openIssues: issues.states.get('open') ?? 0,
      closedIssues: issues.states.get('closed') ?? 0,
      openPrs: prs.states.get('open') ?? 0,
      mergedPrs: prs.states.get('merged') ?? 0,
      issuesOpenedThisWeek: thisWeek.issuesOpened,
      issuesClosedThisWeek: thisWeek.issuesClosed,
      prsOpenedThisWeek: thisWeek.prsOpened,
      prsClosedThisWeek: thisWeek.prsClosed,
      issuesOpened7d: issues.opened7d,
      issuesOpenedPrev7d: issues.openedPrev7d,
      issuesClosed7d: issues.closed7d,
      issuesClosedPrev7d: issues.closedPrev7d,
      prsOpened7d: prs.opened7d,
      prsOpenedPrev7d: prs.openedPrev7d,
      prsClosed7d: prs.closed7d,
      prsClosedPrev7d: prs.closedPrev7d,
      weekly,
    };
  }
}

interface WorkspaceRow {
  id: string;
  name: string;
  slug: string;
  description: string;
  visibility: string;
  owner_id: string | null;
  created_at: number;
  repo_count: number;
  member_count: number;
}

function workspaceRowToRecord(row: WorkspaceRow): WorkspaceRecord {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    visibility: row.visibility === 'private' ? 'private' : 'public',
    ownerId: row.owner_id,
    createdAt: row.created_at,
    repoCount: row.repo_count,
    memberCount: row.member_count,
  };
}
