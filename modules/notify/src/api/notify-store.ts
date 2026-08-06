import type { Database } from '@moxxy/companion-sdk/server';
import type { IntegrationScope } from '@companion/module-integrations/contract';
import type { NotifyDeliveryRecord, NotifyDeliveryStatus } from '../contract/index.js';

interface DeliveryRow {
  id: string;
  connection_id: string;
  provider_id: string;
  connection_name: string;
  scope_key: string;
  owner_id: string | null;
  title: string;
  status: string;
  http_status: number | null;
  error: string | null;
  attempts: number;
  created_at: number;
}

function rowToDelivery(row: DeliveryRow): NotifyDeliveryRecord {
  return {
    id: row.id,
    connectionId: row.connection_id,
    providerId: row.provider_id,
    connectionName: row.connection_name,
    title: row.title,
    status: row.status as NotifyDeliveryStatus,
    httpStatus: row.http_status,
    error: row.error,
    attempts: row.attempts,
    createdAt: row.created_at,
  };
}

/** Delivery attempts older than this are swept on insert, read, and scheduled maintenance. */
const DELIVERY_RETENTION_MS = 14 * 24 * 60 * 60_000;

/** Owner of the bounded provider-neutral notification delivery log. */
export class NotifyStore {
  constructor(private readonly db: Database) {}

  logDelivery(entry: NotifyDeliveryRecord, scope: IntegrationScope, ownerId: string | null): void {
    this.db
      .prepare(
        `INSERT INTO notify_deliveries
           (id, connection_id, provider_id, connection_name, scope_key, owner_id,
            title, status, http_status, error, attempts, created_at)
         VALUES (@id, @connectionId, @providerId, @connectionName, @scopeKey, @ownerId,
                 @title, @status, @httpStatus, @error, @attempts, @createdAt)`,
      )
      .run({ ...entry, scopeKey: deliveryScopeKey(scope), ownerId });
    this.prune();
  }

  deliveriesForScopes(
    scopes: readonly IntegrationScope[],
    ownerId: string | null,
    limit = 100,
  ): NotifyDeliveryRecord[] {
    this.prune();
    const keys = [...new Set(scopes.map(deliveryScopeKey))];
    if (keys.length === 0) return [];
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 500);
    const rows: DeliveryRow[] = [];
    // Keep below SQLite's conservative variable ceiling. Taking the newest
    // `bounded` rows per chunk is sufficient: anything older cannot enter the
    // newest `bounded` rows after the chunk results are merged.
    for (let offset = 0; offset < keys.length; offset += 400) {
      const chunk = keys.slice(offset, offset + 400);
      const placeholders = chunk.map(() => '?').join(', ');
      rows.push(
        ...(this.db
          .prepare(
            `SELECT * FROM notify_deliveries
             WHERE scope_key IN (${placeholders}) AND (owner_id IS NULL OR owner_id = ?)
             ORDER BY created_at DESC, id DESC LIMIT ?`,
          )
          .all(...chunk, ownerId, bounded) as DeliveryRow[]),
      );
    }
    return rows
      .sort((a, b) => b.created_at - a.created_at || b.id.localeCompare(a.id))
      .slice(0, bounded)
      .map(rowToDelivery);
  }

  prune(now = Date.now()): number {
    return this.db
      .prepare(`DELETE FROM notify_deliveries WHERE created_at < ?`)
      .run(now - DELIVERY_RETENTION_MS).changes;
  }
}

function deliveryScopeKey(scope: IntegrationScope): string {
  switch (scope.kind) {
    case 'instance': return 'instance';
    case 'workspace': return `workspace:${scope.workspaceId}`;
    case 'repository': return `repository:${scope.workspaceId}:${scope.repo}`;
  }
}
