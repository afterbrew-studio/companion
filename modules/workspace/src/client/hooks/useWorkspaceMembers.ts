import { useCallback, useEffect, useState } from 'react';
import type { WorkspaceMember } from '../../contract/index.js';
import { workspaceApi } from '../api.js';

/**
 * A private workspace's member list with add/remove — each mutation returns the
 * fresh list, so there's no separate refetch. `members` is null until loaded.
 */
export function useWorkspaceMembers(workspaceId: string): {
  members: WorkspaceMember[] | null;
  error: string | null;
  setError: (e: string | null) => void;
  refresh: () => Promise<void>;
  add: (username: string) => Promise<void>;
  remove: (name: string) => Promise<void>;
} {
  const [members, setMembers] = useState<WorkspaceMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { members } = await workspaceApi.listWorkspaceMembers(workspaceId);
      setMembers(members);
    } catch (err) {
      setError(String(err));
    }
  }, [workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const add = async (username: string): Promise<void> => {
    setError(null);
    const { members } = await workspaceApi.addWorkspaceMember(workspaceId, username);
    setMembers(members);
  };

  const remove = async (name: string): Promise<void> => {
    setError(null);
    try {
      const { members } = await workspaceApi.removeWorkspaceMember(workspaceId, name);
      setMembers(members);
    } catch (err) {
      setError(String(err));
    }
  };

  return { members, error, setError, refresh, add, remove };
}
