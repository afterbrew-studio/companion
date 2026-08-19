import type { Database } from '@moxxy/companion-sdk/server';
import type { DeskContextRef, DeskMissionRecord } from '../contract/index.js';

/** Durable mission metadata. Run lifecycle remains owned by module-operate. */
export class MissionsStore {
  constructor(private readonly db: Database) {}

  insert(ownerId: string, mission: DeskMissionRecord): void {
    this.db
      .prepare(
        `INSERT INTO desk_missions
           (id, owner_id, title, workspace_id, repo, runner_id, harness, contexts, run_id, archived, created_at, updated_at)
         VALUES
           (@id, @ownerId, @title, @workspaceId, @repo, @runnerId, @harness, @contexts, @runId, @archived, @createdAt, @updatedAt)`,
      )
      .run({
        id: mission.id,
        ownerId,
        title: mission.title,
        workspaceId: mission.workspaceId,
        repo: mission.repo,
        runnerId: mission.runnerId,
        harness: mission.harness,
        contexts: JSON.stringify(mission.contexts),
        runId: mission.runId,
        archived: mission.archived ? 1 : 0,
        createdAt: mission.createdAt,
        updatedAt: mission.updatedAt,
      });
  }

  getForOwner(id: string, ownerId: string): DeskMissionRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM desk_missions WHERE id = ? AND owner_id = ?`)
      .get(id, ownerId) as MissionRow | undefined;
    return row ? rowToMission(row) : null;
  }

  listForOwner(ownerId: string, archived = false, limit = 100): DeskMissionRecord[] {
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const rows = this.db
      .prepare(
        `SELECT * FROM desk_missions
         WHERE owner_id = ? AND archived = ?
         ORDER BY updated_at DESC, id DESC LIMIT ?`,
      )
      .all(ownerId, archived ? 1 : 0, bounded) as MissionRow[];
    return rows.map(rowToMission);
  }

  update(
    id: string,
    ownerId: string,
    fields: {
      readonly title?: string;
      readonly repo?: string | null;
      readonly runnerId?: string | null;
      readonly harness?: string | null;
      readonly contexts?: readonly DeskContextRef[];
      readonly archived?: boolean;
    },
  ): DeskMissionRecord | null {
    const current = this.getForOwner(id, ownerId);
    if (!current) return null;
    const next = {
      title: fields.title ?? current.title,
      repo: fields.repo === undefined ? current.repo : fields.repo,
      runnerId: fields.runnerId === undefined ? current.runnerId : fields.runnerId,
      harness: fields.harness === undefined ? current.harness : fields.harness,
      contexts: fields.contexts ?? current.contexts,
      archived: fields.archived ?? current.archived,
      updatedAt: Date.now(),
    };
    this.db
      .prepare(
        `UPDATE desk_missions
         SET title = @title, repo = @repo, runner_id = @runnerId, harness = @harness, contexts = @contexts,
             archived = @archived, updated_at = @updatedAt
         WHERE id = @id AND owner_id = @ownerId`,
      )
      .run({
        id,
        ownerId,
        title: next.title,
        repo: next.repo,
        runnerId: next.runnerId,
        harness: next.harness,
        contexts: JSON.stringify(next.contexts),
        archived: next.archived ? 1 : 0,
        updatedAt: next.updatedAt,
      });
    return this.getForOwner(id, ownerId);
  }

  attachRun(id: string, ownerId: string, runId: string): DeskMissionRecord | null {
    this.db
      .prepare(
        `UPDATE desk_missions SET run_id = ?, updated_at = ?
         WHERE id = ? AND owner_id = ? AND run_id IS NULL AND archived = 0`,
      )
      .run(runId, Date.now(), id, ownerId);
    return this.getForOwner(id, ownerId);
  }

  touch(id: string, ownerId: string): void {
    this.db.prepare(`UPDATE desk_missions SET updated_at = ? WHERE id = ? AND owner_id = ?`).run(Date.now(), id, ownerId);
  }

  removeForWorkspace(workspaceId: string): number {
    return Number(this.db.prepare(`DELETE FROM desk_missions WHERE workspace_id = ?`).run(workspaceId).changes);
  }
}

interface MissionRow {
  id: string;
  owner_id: string;
  title: string;
  workspace_id: string;
  repo: string | null;
  runner_id: string | null;
  harness: string | null;
  contexts: string;
  run_id: string | null;
  archived: number;
  created_at: number;
  updated_at: number;
}

function rowToMission(row: MissionRow): DeskMissionRecord {
  let contexts: DeskContextRef[] = [];
  try {
    const parsed = JSON.parse(row.contexts) as unknown;
    if (Array.isArray(parsed)) contexts = parsed.filter(isContextRef);
  } catch {
    // A damaged context list must not hide the mission or its transcript.
  }
  return {
    id: row.id,
    title: row.title,
    workspaceId: row.workspace_id,
    repo: row.repo,
    runnerId: row.runner_id,
    harness: row.harness,
    contexts,
    runId: row.run_id,
    archived: !!row.archived,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isContextRef(value: unknown): value is DeskContextRef {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    (item.kind === 'pull-request' || item.kind === 'issue') &&
    typeof item.repo === 'string' &&
    item.repo.length > 0 &&
    Number.isInteger(item.number) &&
    Number(item.number) > 0
  );
}
