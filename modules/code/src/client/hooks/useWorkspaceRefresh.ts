import { useEffect, useState } from 'react';
import { codeApi as api } from '../api.js';

/**
 * Refresh GitHub when a workspace feed becomes visible. The cached page renders
 * immediately; sync broadcasts replace it with authoritative data as repos land.
 */
export function useWorkspaceRefresh(workspaceId: string | undefined): string | null {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    if (!workspaceId) return;

    let active = true;
    void api.refreshWorkspace(workspaceId).catch((err: unknown) => {
      if (active) setError(String(err));
    });
    return () => {
      active = false;
    };
  }, [workspaceId]);

  return error;
}
