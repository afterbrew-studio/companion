import { safeParse, type Database } from '@moxxy/companion-sdk/server';
import type { ModelProviderRecord, ModelRecord } from '../contract/index.js';

interface ProviderRow {
  id: string;
  label: string;
  kind: string;
  base_url: string | null;
  headers: string;
  query: string;
  api_version: string | null;
  factory_options: string;
  models: string;
  workspace_ids: string | null;
  enabled: number;
  created_at: number;
}

export class ProvidersStore {
  constructor(private readonly db: Database) {}

  list(): ProviderRow[] {
    return this.db.prepare(`SELECT * FROM model_providers ORDER BY created_at ASC`).all() as ProviderRow[];
  }

  get(id: string): ProviderRow | null {
    return (this.db.prepare(`SELECT * FROM model_providers WHERE id = ?`).get(id) as ProviderRow | undefined) ?? null;
  }

  insert(row: ProviderRow): void {
    this.db
      .prepare(
        `INSERT INTO model_providers
           (id, label, kind, base_url, headers, query, api_version, factory_options, models, workspace_ids, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.label,
        row.kind,
        row.base_url,
        row.headers,
        row.query,
        row.api_version,
        row.factory_options,
        row.models,
        row.workspace_ids,
        row.enabled,
        row.created_at,
      );
  }

  update(row: ProviderRow): void {
    this.db
      .prepare(
        `UPDATE model_providers SET
           label = ?, kind = ?, base_url = ?, headers = ?, query = ?, api_version = ?,
           factory_options = ?, models = ?, workspace_ids = ?, enabled = ?
         WHERE id = ?`,
      )
      .run(
        row.label,
        row.kind,
        row.base_url,
        row.headers,
        row.query,
        row.api_version,
        row.factory_options,
        row.models,
        row.workspace_ids,
        row.enabled,
        row.id,
      );
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM model_providers WHERE id = ?`).run(id);
  }
}

/** Row → record. The credential is not in the row, so nothing has to be stripped. */
export function rowToProvider(row: ProviderRow, hasKey: boolean): ModelProviderRecord {
  return {
    id: row.id,
    label: row.label,
    // `ProviderKind` is deliberately open (plugins may add kinds), so a stored
    // kind this build has never heard of passes through verbatim rather than
    // crashing; the routes edge is what rejects unknown kinds on the way IN.
    kind: row.kind,
    baseUrl: row.base_url,
    headers: safeParse<Record<string, string>>(row.headers, {}),
    query: safeParse<Record<string, string>>(row.query, {}),
    apiVersion: row.api_version,
    factoryOptions: safeParse<Record<string, unknown>>(row.factory_options, {}),
    hasKey,
    models: safeParse<ModelRecord[]>(row.models, []),
    workspaceIds: row.workspace_ids === null ? null : safeParse<string[]>(row.workspace_ids, []),
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
}

export type { ProviderRow };
