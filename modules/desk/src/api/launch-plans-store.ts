import type { Database } from '@moxxy/companion-sdk/server';
import type {
  DeskContextRef,
  DeskLaunchPlanRecord,
  DeskLaunchPlanStatus,
  DeskMissionLaunchSpec,
} from '../contract/index.js';

/** Durable review boundary between the delegated Terminal agent and mission
 * execution. Plans are owner-scoped and short lived. */
export class LaunchPlansStore {
  constructor(private readonly db: Database) {}

  insert(ownerId: string, plan: DeskLaunchPlanRecord): void {
    this.prune(ownerId, plan.createdAt);
    this.db.prepare(
      `INSERT INTO desk_launch_plans
         (id, owner_id, workspace_id, missions, status, mission_ids, created_at, expires_at, executed_at, error)
       VALUES
         (@id, @ownerId, @workspaceId, @missions, @status, @missionIds, @createdAt, @expiresAt, @executedAt, @error)`,
    ).run({
      id: plan.id,
      ownerId,
      workspaceId: plan.workspaceId,
      missions: JSON.stringify(plan.missions),
      status: plan.status,
      missionIds: JSON.stringify(plan.missionIds),
      createdAt: plan.createdAt,
      expiresAt: plan.expiresAt,
      executedAt: plan.executedAt,
      error: plan.error,
    });
  }

  getForOwner(id: string, ownerId: string): DeskLaunchPlanRecord | null {
    const row = this.db.prepare(`SELECT * FROM desk_launch_plans WHERE id = ? AND owner_id = ?`)
      .get(id, ownerId) as LaunchPlanRow | undefined;
    return row ? rowToPlan(row) : null;
  }

  listForOwner(ownerId: string, workspaceId: string, limit = 20): DeskLaunchPlanRecord[] {
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 50);
    return (this.db.prepare(
      `SELECT * FROM desk_launch_plans
       WHERE owner_id = ? AND workspace_id = ?
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(ownerId, workspaceId, bounded) as LaunchPlanRow[]).map(rowToPlan);
  }

  pendingCount(ownerId: string): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS count FROM desk_launch_plans WHERE owner_id = ? AND status = 'pending' AND expires_at > ?`,
    ).get(ownerId, Date.now()) as { readonly count: number };
    return row.count;
  }

  claim(id: string, ownerId: string): boolean {
    return this.db.prepare(
      `UPDATE desk_launch_plans SET status = 'executing'
       WHERE id = ? AND owner_id = ? AND status = 'pending' AND expires_at > ?`,
    ).run(id, ownerId, Date.now()).changes === 1;
  }

  complete(id: string, missionIds: readonly string[]): void {
    this.db.prepare(
      `UPDATE desk_launch_plans
       SET status = 'completed', mission_ids = ?, executed_at = ?, error = NULL
       WHERE id = ? AND status = 'executing'`,
    ).run(JSON.stringify(missionIds), Date.now(), id);
  }

  fail(id: string, error: string, missionIds: readonly string[]): void {
    this.db.prepare(
      `UPDATE desk_launch_plans
       SET status = 'failed', mission_ids = ?, executed_at = ?, error = ?
       WHERE id = ? AND status = 'executing'`,
    ).run(JSON.stringify(missionIds), Date.now(), error.slice(0, 2_000), id);
  }

  cancel(id: string, ownerId: string): boolean {
    return this.db.prepare(
      `UPDATE desk_launch_plans SET status = 'cancelled', executed_at = ?
       WHERE id = ? AND owner_id = ? AND status = 'pending'`,
    ).run(Date.now(), id, ownerId).changes === 1;
  }

  expireForOwner(ownerId: string): number {
    return Number(this.db.prepare(
      `UPDATE desk_launch_plans SET status = 'expired'
       WHERE owner_id = ? AND status = 'pending' AND expires_at <= ?`,
    ).run(ownerId, Date.now()).changes);
  }

  failInterrupted(): number {
    return Number(this.db.prepare(
      `UPDATE desk_launch_plans
       SET status = 'failed', executed_at = ?, error = 'Companion restarted while starting these missions. Inspect the mission list before trying again.'
       WHERE status = 'executing'`,
    ).run(Date.now()).changes);
  }

  removeForWorkspace(workspaceId: string): number {
    return Number(this.db.prepare(`DELETE FROM desk_launch_plans WHERE workspace_id = ?`).run(workspaceId).changes);
  }

  private prune(ownerId: string, now: number): void {
    this.db.prepare(
      `DELETE FROM desk_launch_plans
       WHERE owner_id = ? AND created_at < ? AND status NOT IN ('pending', 'executing')`,
    ).run(ownerId, now - 30 * 24 * 60 * 60_000);
  }
}

interface LaunchPlanRow {
  id: string;
  owner_id: string;
  workspace_id: string;
  missions: string;
  status: string;
  mission_ids: string;
  created_at: number;
  expires_at: number;
  executed_at: number | null;
  error: string | null;
}

function rowToPlan(row: LaunchPlanRow): DeskLaunchPlanRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    missions: parseMissions(row.missions),
    status: launchStatus(row.status),
    missionIds: parseStrings(row.mission_ids),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    executedAt: row.executed_at,
    error: row.error,
  };
}

function parseMissions(raw: string): DeskMissionLaunchSpec[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isMissionLaunchSpec) : [];
  } catch {
    return [];
  }
}

function parseStrings(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function isMissionLaunchSpec(value: unknown): value is DeskMissionLaunchSpec {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.title === 'string' &&
    typeof item.prompt === 'string' &&
    (item.repo === null || typeof item.repo === 'string') &&
    Array.isArray(item.contexts) && item.contexts.every(isContextRef)
  );
}

function isContextRef(value: unknown): value is DeskContextRef {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    (item.kind === 'pull-request' || item.kind === 'issue') &&
    typeof item.repo === 'string' &&
    Number.isInteger(item.number) &&
    Number(item.number) > 0
  );
}

function launchStatus(value: string): DeskLaunchPlanStatus {
  if (
    value === 'pending' || value === 'executing' || value === 'completed' ||
    value === 'failed' || value === 'cancelled' || value === 'expired'
  ) return value;
  return 'failed';
}
