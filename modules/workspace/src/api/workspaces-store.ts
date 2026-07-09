import type Database from 'better-sqlite3';
import type { AuthUser } from '@companion/contracts';
import type {
  WorkspaceMember,
  WorkspaceMemberRole,
  WorkspaceMetrics,
  WorkspaceRecord,
  WorkspaceVisibility,
} from '../contract/index.js';

/**
 * Workspaces group repos; the dashboard metrics roll up per workspace. This
 * store owns the access-control predicates (`canAccess`/`canManage`/
 * `canAccessRepo`/`accessibleIds`) — the scoping key every other module resolves
 * through. Metrics/`canAccessRepo` read code-owned tables (repos/issues/prs) by
 * design; those tables persist regardless of module-code's enabled state.
 */
export class WorkspacesStore {
  constructor(private readonly db: Database.Database) {}

  /** Every install has at least one workspace; orphan repos are adopted into it. */
  ensureDefault(): void {
    const count = this.db.prepare(`SELECT COUNT(*) AS n FROM workspaces`).get() as { n: number };
    if (count.n === 0) {
      this.db
        .prepare(`INSERT INTO workspaces (id, name, slug, description, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run('ws-default', 'Default', 'default', 'Default workspace', Date.now());
    }
    const first = this.db.prepare(`SELECT id FROM workspaces ORDER BY created_at LIMIT 1`).get() as { id: string };
    this.db.prepare(`UPDATE repos SET workspace_id = ? WHERE workspace_id IS NULL`).run(first.id);
  }

  private readonly selectCols = `SELECT w.*,
    (SELECT COUNT(*) FROM repos r WHERE r.workspace_id = w.id) AS repo_count,
    (SELECT COUNT(*) FROM workspace_members m WHERE m.workspace_id = w.id) AS member_count
    FROM workspaces w`;

  list(): WorkspaceRecord[] {
    const rows = this.db.prepare(`${this.selectCols} ORDER BY w.created_at`).all() as WorkspaceRow[];
    return rows.map(workspaceRowToRecord);
  }

  listFor(user: AuthUser): WorkspaceRecord[] {
    if (user.role === 'admin') return this.list();
    const rows = this.db
      .prepare(
        `${this.selectCols}
         WHERE w.visibility = 'public'
            OR EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = w.id AND m.username = ?)
         ORDER BY w.created_at`,
      )
      .all(user.username) as WorkspaceRow[];
    return rows.map(workspaceRowToRecord);
  }

  get(id: string): WorkspaceRecord | undefined {
    const row = this.db.prepare(`${this.selectCols} WHERE w.id = ?`).get(id) as WorkspaceRow | undefined;
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

  delete(id: string): void {
    this.db.prepare(`DELETE FROM pipelines WHERE workspace_id = ?`).run(id);
    this.db.prepare(`DELETE FROM step_definitions WHERE workspace_id = ?`).run(id);
    this.db.prepare(`DELETE FROM workspace_members WHERE workspace_id = ?`).run(id);
    this.db.prepare(`DELETE FROM workspaces WHERE id = ?`).run(id);
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

  /** Can this user see the workspace? Admins: always. Public: always. Private: members. */
  canAccess(user: AuthUser, ws: WorkspaceRecord): boolean {
    return user.role === 'admin' || ws.visibility === 'public' || this.isMember(ws.id, user.username);
  }

  /** Convenience for cross-module callers that only have the id. */
  canAccessWorkspace(user: AuthUser, id: string): boolean {
    const ws = this.get(id);
    return ws ? this.canAccess(user, ws) : false;
  }

  canManage(user: AuthUser, ws: WorkspaceRecord): boolean {
    return user.role === 'admin' || ws.ownerId === user.username;
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

  private repoVisibility(fullName: string): { id: string; visibility: string; owner_id: string | null } | undefined {
    return this.db
      .prepare(
        `SELECT w.id, w.visibility, w.owner_id
         FROM repos r JOIN workspaces w ON w.id = r.workspace_id
         WHERE r.full_name = ?`,
      )
      .get(fullName) as { id: string; visibility: string; owner_id: string | null } | undefined;
  }

  /** Can this user see a repo? Follows its workspace's access rule. */
  canAccessRepo(user: AuthUser, fullName: string): boolean {
    if (user.role === 'admin') return true;
    const w = this.repoVisibility(fullName);
    if (!w) return true;
    return w.visibility === 'public' || this.isMember(w.id, user.username);
  }

  /** Ids of the workspaces a user may see — for filtering global listings. */
  accessibleIds(user: AuthUser): Set<string> {
    return new Set(this.listFor(user).map((w) => w.id));
  }

  /** Counters + weekly open/close velocity for a workspace's dashboard. */
  metrics(workspaceId: string, weeks = 12): WorkspaceMetrics {
    const issues = this.db
      .prepare(
        `SELECT i.state, i.created_at, i.closed_at FROM issues i
         JOIN repos r ON r.full_name = i.repo WHERE r.workspace_id = ?`,
      )
      .all(workspaceId) as Array<{ state: string; created_at: number; closed_at: number | null }>;
    const prs = this.db
      .prepare(
        `SELECT p.state, p.created_at, p.closed_at FROM prs p
         JOIN repos r ON r.full_name = p.repo WHERE r.workspace_id = ?`,
      )
      .all(workspaceId) as Array<{ state: string; created_at: number; closed_at: number | null }>;

    const monday = new Date();
    monday.setHours(0, 0, 0, 0);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const starts: number[] = [];
    for (let i = weeks - 1; i >= 0; i--) starts.push(monday.getTime() - i * 7 * 86_400_000);
    const bucket = (ts: number | null): number => {
      if (ts === null || ts < starts[0]!) return -1;
      for (let i = starts.length - 1; i >= 0; i--) if (ts >= starts[i]!) return i;
      return -1;
    };

    const weekly = starts.map((weekStart) => ({
      weekStart,
      issuesOpened: 0,
      issuesClosed: 0,
      prsOpened: 0,
      prsClosed: 0,
    }));
    for (const i of issues) {
      const opened = bucket(i.created_at);
      if (opened >= 0) weekly[opened]!.issuesOpened++;
      const closed = bucket(i.closed_at);
      if (closed >= 0) weekly[closed]!.issuesClosed++;
    }
    for (const p of prs) {
      const opened = bucket(p.created_at);
      if (opened >= 0) weekly[opened]!.prsOpened++;
      const closed = bucket(p.closed_at);
      if (closed >= 0) weekly[closed]!.prsClosed++;
    }

    const thisWeek = weekly[weekly.length - 1]!;
    const now = Date.now();
    const d7 = now - 7 * 86_400_000;
    const d14 = now - 14 * 86_400_000;
    const win = (ts: number | null, from: number, to: number): boolean => ts !== null && ts >= from && ts < to;

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
