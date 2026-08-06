import { safeParse, type Database } from '@moxxy/companion-sdk/server';
import type {
  IntegrationCapability,
  IntegrationConnectionRecord,
  IntegrationFieldValue,
  IntegrationHealthStatus,
  IntegrationRouteRecord,
  IntegrationScope,
  IntegrationTargetRef,
} from '../contract/index.js';

interface ConnectionRow {
  id: string;
  provider_id: string;
  name: string;
  scope_kind: IntegrationScope['kind'];
  workspace_id: string | null;
  repo: string | null;
  owner_id: string | null;
  config: string;
  enabled: number;
  health_status: IntegrationHealthStatus;
  health_message: string;
  checked_at: number | null;
  created_at: number;
  updated_at: number;
}

interface RouteRow {
  capability: string;
  scope_key: string;
  scope_kind: IntegrationScope['kind'];
  workspace_id: string | null;
  repo: string | null;
  targets: string;
  updated_at: number;
}

export function scopeKey(scope: IntegrationScope): string {
  switch (scope.kind) {
    case 'instance':
      return 'instance';
    case 'workspace':
      return `workspace:${scope.workspaceId}`;
    case 'repository':
      return `repository:${scope.workspaceId}:${scope.repo}`;
  }
}

function rowScope(row: Pick<ConnectionRow | RouteRow, 'scope_kind' | 'workspace_id' | 'repo'>): IntegrationScope {
  if (row.scope_kind === 'instance') return { kind: 'instance' };
  if (row.scope_kind === 'workspace') return { kind: 'workspace', workspaceId: row.workspace_id! };
  return { kind: 'repository', workspaceId: row.workspace_id!, repo: row.repo! };
}

function rowToConnection(row: ConnectionRow, configuredSecrets: readonly string[]): IntegrationConnectionRecord {
  return {
    id: row.id,
    providerId: row.provider_id,
    name: row.name,
    scope: rowScope(row),
    ownerId: row.owner_id,
    enabled: !!row.enabled,
    config: safeParse<Record<string, IntegrationFieldValue>>(row.config, {}),
    configuredSecrets,
    health: {
      status: row.health_status,
      message: row.health_message,
      checkedAt: row.checked_at,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToRoute(row: RouteRow): IntegrationRouteRecord {
  return {
    capability: row.capability,
    scope: rowScope(row),
    targets: safeParse<IntegrationTargetRef[]>(row.targets, []),
    updatedAt: row.updated_at,
  };
}

/** Owner of provider-agnostic connection metadata and select-one routes. */
export class IntegrationsStore {
  constructor(private readonly db: Database) {}

  insert(input: {
    readonly id: string;
    readonly providerId: string;
    readonly name: string;
    readonly scope: IntegrationScope;
    readonly ownerId: string | null;
    readonly enabled: boolean;
    readonly config: Readonly<Record<string, IntegrationFieldValue>>;
    readonly createdAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO integration_connections
           (id, provider_id, name, scope_kind, workspace_id, repo, owner_id, config, enabled,
            health_status, health_message, created_at, updated_at)
         VALUES (@id, @providerId, @name, @scopeKind, @workspaceId, @repo, @ownerId, @config, @enabled,
                 'unknown', 'Not checked yet', @createdAt, @createdAt)`,
      )
      .run({
        id: input.id,
        providerId: input.providerId,
        name: input.name,
        ownerId: input.ownerId,
        createdAt: input.createdAt,
        scopeKind: input.scope.kind,
        workspaceId: input.scope.kind === 'instance' ? null : input.scope.workspaceId,
        repo: input.scope.kind === 'repository' ? input.scope.repo : null,
        config: JSON.stringify(input.config),
        enabled: input.enabled ? 1 : 0,
      });
  }

  update(
    id: string,
    patch: {
      readonly name?: string;
      readonly scope?: IntegrationScope;
      readonly enabled?: boolean;
      readonly config?: Readonly<Record<string, IntegrationFieldValue>>;
    },
  ): void {
    const current = this.row(id);
    if (!current) return;
    const scope = patch.scope ?? rowScope(current);
    this.db
      .prepare(
        `UPDATE integration_connections SET
           name = ?, scope_kind = ?, workspace_id = ?, repo = ?, enabled = ?, config = ?,
           health_status = CASE WHEN ? THEN 'unknown' ELSE health_status END,
           health_message = CASE WHEN ? THEN 'Configuration changed; test again' ELSE health_message END,
           checked_at = CASE WHEN ? THEN NULL ELSE checked_at END,
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.name ?? current.name,
        scope.kind,
        scope.kind === 'instance' ? null : scope.workspaceId,
        scope.kind === 'repository' ? scope.repo : null,
        (patch.enabled ?? !!current.enabled) ? 1 : 0,
        JSON.stringify(patch.config ?? safeParse<Record<string, IntegrationFieldValue>>(current.config, {})),
        patch.config !== undefined ? 1 : 0,
        patch.config !== undefined ? 1 : 0,
        patch.config !== undefined ? 1 : 0,
        Date.now(),
        id,
      );
  }

  setHealth(id: string, status: IntegrationHealthStatus, message: string, checkedAt: number | null): void {
    this.db
      .prepare(
        `UPDATE integration_connections
         SET health_status = ?, health_message = ?, checked_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(status, message.slice(0, 1_000), checkedAt, Date.now(), id);
  }

  delete(id: string): boolean {
    return this.db.prepare(`DELETE FROM integration_connections WHERE id = ?`).run(id).changes > 0;
  }

  private row(id: string): ConnectionRow | undefined {
    return this.db.prepare(`SELECT * FROM integration_connections WHERE id = ?`).get(id) as ConnectionRow | undefined;
  }

  get(id: string, configuredSecrets: readonly string[] = []): IntegrationConnectionRecord | undefined {
    const row = this.row(id);
    return row ? rowToConnection(row, configuredSecrets) : undefined;
  }

  list(secretKeys: (id: string) => readonly string[]): IntegrationConnectionRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM integration_connections ORDER BY updated_at DESC, name COLLATE NOCASE`)
      .all() as ConnectionRow[];
    return rows.map((row) => rowToConnection(row, secretKeys(row.id)));
  }

  upsertRoute(capability: IntegrationCapability, scope: IntegrationScope, targets: readonly IntegrationTargetRef[]): void {
    this.db
      .prepare(
        `INSERT INTO integration_routes
           (capability, scope_key, scope_kind, workspace_id, repo, targets, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(capability, scope_key) DO UPDATE SET
           targets = excluded.targets, updated_at = excluded.updated_at`,
      )
      .run(
        capability,
        scopeKey(scope),
        scope.kind,
        scope.kind === 'instance' ? null : scope.workspaceId,
        scope.kind === 'repository' ? scope.repo : null,
        JSON.stringify(targets),
        Date.now(),
      );
  }

  route(capability: IntegrationCapability, scope: IntegrationScope): IntegrationRouteRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM integration_routes WHERE capability = ? AND scope_key = ?`)
      .get(capability, scopeKey(scope)) as RouteRow | undefined;
    return row ? rowToRoute(row) : undefined;
  }

  deleteRoute(capability: IntegrationCapability, scope: IntegrationScope): void {
    this.db
      .prepare(`DELETE FROM integration_routes WHERE capability = ? AND scope_key = ?`)
      .run(capability, scopeKey(scope));
  }

  routes(): IntegrationRouteRecord[] {
    return (this.db.prepare(`SELECT * FROM integration_routes ORDER BY capability, scope_key`).all() as RouteRow[]).map(
      rowToRoute,
    );
  }

  deleteRoutesUsingConnection(connectionId: string): boolean {
    let changed = false;
    for (const route of this.routes()) {
      const targets = route.targets.filter((target) => target.connectionId !== connectionId);
      if (targets.length === route.targets.length) continue;
      changed = true;
      if (targets.length === 0) this.deleteRoute(route.capability, route.scope);
      else this.upsertRoute(route.capability, route.scope, targets);
    }
    return changed;
  }
}
