import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { WorkspaceRecord } from '@companion/contract';
import { api, onServerMessage } from './api.js';

/**
 * The active workspace scopes the three main areas (Proposals, Issues, Pull
 * Requests) and the pipelines library. Selection persists per browser.
 */

const CURRENT_KEY = 'companion.workspace';

interface WorkspaceState {
  readonly workspaces: readonly WorkspaceRecord[];
  /** null while the list is loading or empty. */
  readonly current: WorkspaceRecord | null;
  readonly setCurrent: (id: string) => void;
  readonly refresh: () => Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceState | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }): JSX.Element {
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceRecord[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(localStorage.getItem(CURRENT_KEY));

  const refresh = useCallback(async () => {
    try {
      const { workspaces } = await api.listWorkspaces();
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
      if (msg.t === 'workspaces.changed' || msg.t === 'repos.changed') void refresh();
    });
  }, [refresh]);

  const current = workspaces.find((w) => w.id === currentId) ?? workspaces[0] ?? null;

  const setCurrent = useCallback((id: string) => {
    localStorage.setItem(CURRENT_KEY, id);
    setCurrentId(id);
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
