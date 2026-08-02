import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { invalidateCached, onServerMessage } from '@moxxy/companion-sdk/client';
import type { WorkspaceRecord } from '../../contract/index.js';
import { workspaceApi } from '../api.js';

/**
 * The active workspace scopes the three main areas (Ideas, Issues, Pull
 * Requests) and the pipelines library. Selection persists per browser.
 */

const CURRENT_KEY = 'companion.workspace';

interface WorkspaceState {
  readonly workspaces: readonly WorkspaceRecord[];
  /** null while the list is loading or empty. */
  readonly current: WorkspaceRecord | null;
  /**
   * Switch the active workspace. A genuine switch lands on that workspace's
   * Overview; pass `{ navigate: false }` to stay put (e.g. a fallback after
   * deleting the current workspace from an admin page).
   */
  readonly setCurrent: (id: string, opts?: { navigate?: boolean }) => void;
  readonly refresh: () => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceState | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }): JSX.Element {
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceRecord[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(localStorage.getItem(CURRENT_KEY));

  const refresh = useCallback(async () => {
    try {
      const { workspaces } = await workspaceApi.listWorkspaces();
      // Keep the previous array (and thus `current`'s identity) when nothing
      // changed: repos.changed fires on every sync tick, and handing pages a
      // fresh `current` object each time restarts their fetch loops.
      setWorkspaces((prev) => (JSON.stringify(prev) === JSON.stringify(workspaces) ? prev : workspaces));
    } catch {
      // signed out or the daemon is down; the shell surfaces that elsewhere
    }
  }, []);

  useEffect(() => {
    void refresh();
    return onServerMessage((msg) => {
      // `repos.changed` belongs to module-operate (which depends on us), so its
      // registration is invisible to this compilation — match it as a string.
      const t: string = msg.t;
      if (t === 'workspaces.changed' || t === 'repos.changed') void refresh();
    });
  }, [refresh]);

  const current = workspaces.find((w) => w.id === currentId) ?? workspaces[0] ?? null;

  const setCurrent = useCallback((id: string, opts?: { navigate?: boolean }) => {
    setCurrentId((prev) => {
      if (id !== prev) {
        // Retained page payloads were fetched under the old scope. A repo this
        // workspace cannot reach must not render from the previous one's copy
        // while its refetch is still in the air.
        invalidateCached();
        // Switching workspaces is a context change — land on the new workspace's
        // Overview so scoped areas (and its inbox) reflect the switch immediately.
        if (opts?.navigate !== false) location.hash = '#/overview';
      }
      return id;
    });
    localStorage.setItem(CURRENT_KEY, id);
  }, []);

  return (
    <WorkspaceContext.Provider value={{ workspaces, current, setCurrent, refresh }}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace(): WorkspaceState {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace outside WorkspaceProvider');
  return ctx;
}
