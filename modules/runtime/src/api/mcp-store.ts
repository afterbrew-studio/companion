import { safeParse, type Database } from '@moxxy/companion-sdk/server';
import type { McpServerRecord, RuntimeAccess } from '../contract/index.js';

interface McpServerRow {
  id: string;
  label: string;
  transport: string;
  command: string | null;
  args: string;
  env: string;
  url: string | null;
  headers: string;
  access: string;
  tools: string | null;
  workspace_ids: string | null;
  enabled: number;
  created_at: number;
}

export class McpServersStore {
  constructor(private readonly db: Database) {}

  list(): McpServerRow[] {
    return this.db.prepare(`SELECT * FROM mcp_servers ORDER BY created_at ASC`).all() as McpServerRow[];
  }

  get(id: string): McpServerRow | null {
    return (this.db.prepare(`SELECT * FROM mcp_servers WHERE id = ?`).get(id) as McpServerRow | undefined) ?? null;
  }

  insert(row: McpServerRow): void {
    this.db
      .prepare(
        `INSERT INTO mcp_servers
           (id, label, transport, command, args, env, url, headers, access, tools, workspace_ids, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.label,
        row.transport,
        row.command,
        row.args,
        row.env,
        row.url,
        row.headers,
        row.access,
        row.tools,
        row.workspace_ids,
        row.enabled,
        row.created_at,
      );
  }

  update(row: McpServerRow): void {
    this.db
      .prepare(
        `UPDATE mcp_servers SET
           label = ?, transport = ?, command = ?, args = ?, env = ?, url = ?, headers = ?,
           access = ?, tools = ?, workspace_ids = ?, enabled = ?
         WHERE id = ?`,
      )
      .run(
        row.label,
        row.transport,
        row.command,
        row.args,
        row.env,
        row.url,
        row.headers,
        row.access,
        row.tools,
        row.workspace_ids,
        row.enabled,
        row.id,
      );
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM mcp_servers WHERE id = ?`).run(id);
  }
}

/** Row → record. The secret is not in the row, so nothing has to be stripped. */
export function rowToMcpServer(row: McpServerRow, hasSecret: boolean): McpServerRecord {
  return {
    id: row.id,
    label: row.label,
    transport: row.transport === 'http' ? 'http' : 'stdio',
    command: row.command,
    args: safeParse<string[]>(row.args, []),
    env: safeParse<Record<string, string>>(row.env, {}),
    url: row.url,
    headers: safeParse<Record<string, string>>(row.headers, {}),
    access: safeParse<RuntimeAccess[]>(row.access, []),
    tools: row.tools === null ? null : safeParse<string[]>(row.tools, []),
    workspaceIds: row.workspace_ids === null ? null : safeParse<string[]>(row.workspace_ids, []),
    hasSecret,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
}

export type { McpServerRow };
