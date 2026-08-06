import { useCallback, useState } from 'react';
import { useLive } from '@moxxy/companion-sdk/client';
import type { CreateMcpServerRequest, McpCheckResult, McpServerRecord } from '../../contract/index.js';
import { mcpApi } from '../api.js';

export interface McpServersState {
  readonly servers: McpServerRecord[] | null;
  readonly error: string | null;
  readonly busy: boolean;
  create(draft: CreateMcpServerRequest): Promise<void>;
  update(id: string, fields: Partial<CreateMcpServerRequest>): Promise<void>;
  remove(id: string): Promise<void>;
  check(id: string): Promise<McpCheckResult | null>;
}

export function useMcpServers(): McpServersState {
  const [servers, setServers] = useState<McpServerRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setServers((await mcpApi.servers()).servers);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useLive(load, (msg) => msg.t === 'runtime.changed');

  const guard = async (work: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    try {
      await work();
      await load();
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return {
    servers,
    error,
    busy,
    create: (draft) => guard(() => mcpApi.create(draft)),
    update: (id, fields) => guard(() => mcpApi.update(id, fields)),
    remove: (id) => guard(() => mcpApi.remove(id)),
    check: async (id) => {
      setBusy(true);
      try {
        return (await mcpApi.check(id)).result;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        setBusy(false);
      }
    },
  };
}
