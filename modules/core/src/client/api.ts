import type { Role } from '@companion/types';
import {
  ApiError,
  del,
  disconnectWs,
  emitAuthChanged,
  getToken,
  patch,
  post,
  publicPost,
  put,
  qs,
  request,
  setToken,
} from '@companion/core/client';
import type { ModuleConfigState } from '@companion/core';
import type { ModuleDescriptor, PageQuery } from '@companion/core/client';
import type {
  AccountInfo,
  AclMap,
  AuthState,
  CreateUserRequest,
  RoleDetail,
  RoleRecord,
  LoginResponse,
  ProfileResponse,
  SessionInfo,
  UpdateAccountRequest,
  UpdateProfileRequest,
  UpdateUserRequest,
  UserRecord,
} from '../contract/index.js';

/**
 * module-core's REST surface, carved from the legacy `lib/api.ts`: the auth
 * bootstrap/session flows plus the users/profile/account/modules methods this
 * module's pages call. HTTP + token plumbing lives in `@companion/core/client`.
 */

export const authApi = {
  /** Public bootstrap: is first-boot onboarding still pending? */
  async state(): Promise<AuthState> {
    const res = await fetch('/api/auth/state');
    if (!res.ok) throw new ApiError('companiond unreachable', res.status);
    return (await res.json()) as AuthState;
  },

  /** First-boot onboarding: create the admin account and sign in. */
  async setup(username: string, email: string, password: string): Promise<LoginResponse> {
    const session = await publicPost<LoginResponse>('/api/auth/setup', { username, email, password });
    setToken(session.token);
    emitAuthChanged();
    return session;
  },

  async login(username: string, password: string): Promise<LoginResponse> {
    const session = await publicPost<LoginResponse>('/api/auth/login', { username, password });
    setToken(session.token);
    emitAuthChanged();
    return session;
  },

  async logout(): Promise<void> {
    await post('/api/auth/logout').catch(() => undefined);
    setToken(null);
    disconnectWs();
    emitAuthChanged();
  },

  me: () => request<SessionInfo>('/api/auth/me'),
  hasSession: (): boolean => getToken() !== null,
};

export const coreApi = {
  // users (admin)
  listUsers: (opts?: PageQuery & { role?: Role }) =>
    request<{ users: UserRecord[]; total: number }>(`/api/users${qs({ ...opts })}`),
  createUser: (body: CreateUserRequest) => post<{ user: UserRecord }>('/api/users', body),
  updateUser: (username: string, body: UpdateUserRequest) =>
    patch<{ user: UserRecord }>(`/api/users/${username}`, body),
  deleteUser: (username: string) => del<{ ok: true }>(`/api/users/${username}`),

  // roles (admin): the instance's own role definitions
  listRoles: () => request<{ roles: RoleRecord[] }>('/api/roles'),
  getRole: (id: string) => request<{ role: RoleDetail }>(`/api/roles/${id}`),
  createRole: (body: { id: string; title: string; description?: string; from?: string }) =>
    post<{ role: RoleRecord }>('/api/roles', body),
  deleteRole: (id: string) => del<{ ok: true }>(`/api/roles/${id}`),
  adjustRole: (id: string, mode: 'grant' | 'revoke' | 'reset', permissions: readonly string[]) =>
    post<{ role: RoleDetail }>(`/api/roles/${id}/permissions`, { mode, permissions }),
  acl: () => request<AclMap>('/api/acl'),

  // the signed-in user's own settings
  getProfile: () => request<ProfileResponse>('/api/profile'),
  updateProfile: (body: UpdateProfileRequest) => put<ProfileResponse>('/api/profile', body),
  getAccount: () => request<{ account: AccountInfo }>('/api/account'),
  updateAccount: (body: UpdateAccountRequest) => put<{ account: AccountInfo }>('/api/account', body),
};

// runtime module lifecycle + config (admin) — the Modules page drives the kernel with these
export const modulesApi = {
  list: () => request<{ modules: ModuleDescriptor[] }>('/api/modules'),
  install: (id: string, config?: Record<string, unknown>) =>
    post<{ modules: ModuleDescriptor[] }>(`/api/modules/${id}/install`, config ? { config } : {}),
  enable: (id: string) => post<{ modules: ModuleDescriptor[] }>(`/api/modules/${id}/enable`),
  disable: (id: string) => post<{ modules: ModuleDescriptor[] }>(`/api/modules/${id}/disable`),
  uninstall: (id: string) => post<{ modules: ModuleDescriptor[] }>(`/api/modules/${id}/uninstall`),
  // config values are redacted server-side: secret values never cross the wire
  getConfig: (id: string) => request<ModuleConfigState>(`/api/modules/${id}/config`),
  setConfig: (id: string, config: Record<string, unknown>) =>
    put<ModuleConfigState>(`/api/modules/${id}/config`, { config }),
};
