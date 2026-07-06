import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { AuthUser, Permission } from '@companion/contract';
import { auth as authApi, onAuthChanged, connectWs } from './api.js';

interface AuthState {
  /** undefined = still resolving, null = signed out. */
  readonly user: AuthUser | null | undefined;
  /** Clean install: first-boot onboarding must run before anything else. */
  readonly needsSetup: boolean;
  readonly permissions: readonly Permission[];
  readonly can: (permission: Permission) => boolean;
  readonly login: (username: string, password: string) => Promise<void>;
  readonly logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [permissions, setPermissions] = useState<readonly Permission[]>([]);

  const resolve = useCallback(async () => {
    try {
      const state = await authApi.state();
      setNeedsSetup(state.setup);
      if (state.setup) {
        setUser(null);
        setPermissions([]);
        return;
      }
    } catch {
      // daemon unreachable — fall through; login screen surfaces it
    }
    if (!authApi.hasSession()) {
      setUser(null);
      setPermissions([]);
      return;
    }
    try {
      const session = await authApi.me();
      setUser(session.user);
      setPermissions(session.permissions);
      connectWs();
    } catch {
      // 401 handling in api.ts already cleared the token.
      setUser(null);
      setPermissions([]);
    }
  }, []);

  useEffect(() => {
    void resolve();
    return onAuthChanged(() => void resolve());
  }, [resolve]);

  const login = useCallback(async (username: string, password: string) => {
    await authApi.login(username, password);
  }, []);

  const logout = useCallback(async () => {
    await authApi.logout();
  }, []);

  const can = useCallback((p: Permission) => permissions.includes(p), [permissions]);

  return (
    <AuthContext.Provider value={{ user, needsSetup, permissions, can, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
