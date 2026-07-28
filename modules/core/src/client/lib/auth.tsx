import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { AuthUser, Permission } from '@moxxy/companion-contracts';
import { connectWs, onAuthChanged, onServerMessage } from '@moxxy/companion-core/client';
import type { AuthProvider, InstanceBranding, NotificationScope } from '../../contract/index.js';
import { authApi } from '../api.js';

interface AuthState {
  /** undefined = still resolving, null = signed out. */
  readonly user: AuthUser | null | undefined;
  /** Clean install: first-boot onboarding must run before anything else. */
  readonly needsSetup: boolean;
  readonly permissions: readonly Permission[];
  /** Effective inbox scope (per-user override ?? instance default). */
  readonly notificationScope: NotificationScope;
  /** Instance branding (name/logo); available pre-login. */
  readonly branding: InstanceBranding;
  /** Host for user-facing GitHub links; `github.com` unless this instance points at GHES. */
  readonly githubHost: string;
  /** Alternative sign-in methods contributed by identity modules; empty by default. */
  readonly providers: readonly AuthProvider[];
  /** Local update after saving branding in Settings — no refetch needed. */
  readonly setBranding: (b: InstanceBranding) => void;
  readonly can: (permission: Permission) => boolean;
  readonly login: (username: string, password: string) => Promise<void>;
  readonly logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [permissions, setPermissions] = useState<readonly Permission[]>([]);
  const [notificationScope, setNotificationScope] = useState<NotificationScope>('workspace');
  const [branding, setBranding] = useState<InstanceBranding>({ name: null, logo: null });
  const [githubHost, setGithubHost] = useState('github.com');
  const [providers, setProviders] = useState<readonly AuthProvider[]>([]);

  // The uploaded logo becomes the favicon (falling back to the bundled letter
  // tile from index.html). The tab title is route-aware and owned by the
  // shell (App.tsx); pre-login pages set their own.
  useEffect(() => {
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (icon) {
      icon.dataset.defaultHref ??= icon.href;
      icon.href = branding.logo ?? icon.dataset.defaultHref;
    }
  }, [branding]);

  const resolve = useCallback(async () => {
    try {
      const state = await authApi.state();
      setBranding(state.branding);
      setGithubHost(state.githubHost);
      setProviders(state.providers);
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
      setNotificationScope(session.notificationScope);
      connectWs();
    } catch {
      // 401 handling in the net core already cleared the token.
      setUser(null);
      setPermissions([]);
    }
  }, []);

  useEffect(() => {
    void resolve();
    const offAuth = onAuthChanged(() => void resolve());
    // Enabling/disabling a module rebuilds the server RBAC grid; re-resolve the
    // session so can() reflects the new permissions (a just-enabled module's nav
    // + routes appear) without a manual reload.
    const offModules = onServerMessage((msg) => {
      if (msg.t === 'modules.changed') void resolve();
    });
    return () => {
      offAuth();
      offModules();
    };
  }, [resolve]);

  const login = useCallback(async (username: string, password: string) => {
    await authApi.login(username, password);
  }, []);

  const logout = useCallback(async () => {
    await authApi.logout();
  }, []);

  const can = useCallback((p: Permission) => permissions.includes(p), [permissions]);

  return (
    <AuthContext.Provider
      value={{
        user,
        needsSetup,
        permissions,
        notificationScope,
        branding,
        setBranding,
        githubHost,
        providers,
        can,
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
