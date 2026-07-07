import type Database from 'better-sqlite3';
import type { WorkspaceMetrics, WorkspaceRecord } from '@companion/contract';

/** Workspaces group repos; the dashboard metrics roll up per workspace. */
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
    const first = this.db.prepare(`SELECT id FROM workspaces ORDER BY created_at LIMIT 1`).get() as {
      id: string;
    };
    this.db.prepare(`UPDATE repos SET workspace_id = ? WHERE workspace_id IS NULL`).run(first.id);
  }

  list(): WorkspaceRecord[] {
    const rows = this.db
      .prepare(
        `SELECT w.*, (SELECT COUNT(*) FROM repos r WHERE r.workspace_id = w.id) AS repo_count
         FROM workspaces w ORDER BY w.created_at`,
      )
      .all() as WorkspaceRow[];
    return rows.map(workspaceRowToRecord);
  }

  get(id: string): WorkspaceRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT w.*, (SELECT COUNT(*) FROM repos r WHERE r.workspace_id = w.id) AS repo_count
         FROM workspaces w WHERE w.id = ?`,
      )
      .get(id) as WorkspaceRow | undefined;
    return row ? workspaceRowToRecord(row) : undefined;
  }

  insert(w: { id: string; name: string; slug: string; description: string }): void {
    this.db
      .prepare(
        `INSERT INTO workspaces (id, name, slug, description, created_at)
         VALUES (@id, @name, @slug, @description, @createdAt)`,
      )
      .run({ ...w, createdAt: Date.now() });
  }

  update(id: string, fields: { name?: string; description?: string }): void {
    this.db
      .prepare(
        `UPDATE workspaces SET name = COALESCE(?, name), description = COALESCE(?, description) WHERE id = ?`,
      )
      .run(fields.name ?? null, fields.description ?? null, id);
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM pipelines WHERE workspace_id = ?`).run(id);
    this.db.prepare(`DELETE FROM step_definitions WHERE workspace_id = ?`).run(id);
    this.db.prepare(`DELETE FROM workspaces WHERE id = ?`).run(id);
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

    // Monday-start calendar weeks, local time, oldest → newest.
    const monday = new Date();
    monday.setHours(0, 0, 0, 0);
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const starts: number[] = [];
    for (let i = weeks - 1; i >= 0; i--) {
      starts.push(monday.getTime() - i * 7 * 86_400_000);
    }
    const bucket = (ts: number | null): number => {
      if (ts === null) return -1;
      if (ts < starts[0]!) return -1;
      for (let i = starts.length - 1; i >= 0; i--) {
        if (ts >= starts[i]!) return i;
      }
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

    // Rolling 7-day windows: the calendar week is partial for delta purposes.
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
  created_at: number;
  repo_count: number;
}

function workspaceRowToRecord(row: WorkspaceRow): WorkspaceRecord {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    createdAt: row.created_at,
    repoCount: row.repo_count,
  };
}
