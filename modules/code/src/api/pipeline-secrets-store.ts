import type { Database } from '@moxxy/companion-sdk/server';
import type { PipelineSecretMeta, StepSecretVisibility } from '../contract/index.js';

interface Row {
  key: string;
  workspace_id: string;
  owner_id: string;
  visibility: string;
  created_at: number;
}

function rowToMeta(row: Row): PipelineSecretMeta {
  return {
    key: row.key,
    workspaceId: row.workspace_id,
    ownerId: row.owner_id,
    visibility: row.visibility === 'shared' ? 'shared' : 'private',
    createdAt: row.created_at,
  };
}

/**
 * Who owns each hidden step variable, and who else may use it.
 *
 * The value itself is NOT here: it lives in the kernel's `SecretStore` under the
 * same key, so an instance that moved secrets to Vault keeps them there. This
 * table answers the questions that decide whether a run may resolve one, and
 * none of its columns are themselves secret.
 */
export class PipelineSecretsStore {
  constructor(private readonly db: Database) {}

  get(key: string): PipelineSecretMeta | undefined {
    const row = this.db.prepare(`SELECT * FROM pipeline_secrets WHERE key = ?`).get(key) as Row | undefined;
    return row ? rowToMeta(row) : undefined;
  }

  /** Idempotent: re-saving a variable keeps its identity and refreshes intent. */
  upsert(meta: Omit<PipelineSecretMeta, 'createdAt'>): void {
    this.db
      .prepare(
        `INSERT INTO pipeline_secrets (key, workspace_id, owner_id, visibility, created_at)
         VALUES (@key, @workspaceId, @ownerId, @visibility, @createdAt)
         ON CONFLICT(key) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           owner_id = excluded.owner_id,
           visibility = excluded.visibility`,
      )
      .run({ ...meta, createdAt: Date.now() });
  }

  delete(key: string): void {
    this.db.prepare(`DELETE FROM pipeline_secrets WHERE key = ?`).run(key);
  }

  /**
   * May a run started by `username` in `workspaceId` resolve this secret?
   *
   * Refusal is per-reason on purpose: "belongs to another profile" and "belongs
   * to another workspace" send an operator to different places, and a single
   * "not allowed" would send them to neither.
   */
  refusalFor(key: string, username: string, workspaceId: string | null): string | null {
    const meta = this.get(key);
    if (!meta) return 'its stored value is gone';
    if (workspaceId !== null && meta.workspaceId !== workspaceId) {
      return 'it belongs to another workspace';
    }
    if (meta.visibility === 'private' && meta.ownerId !== username) {
      return `it is ${meta.ownerId}'s private value; ask them to share it or set your own`;
    }
    return null;
  }
}

export type { StepSecretVisibility };
