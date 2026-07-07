/**
 * Auth + RBAC contract. Roles are coarse personas; permissions are the fine
 * capability grid every REST route and UI module declares against. Both sides
 * (companiond route table, SPA module registry) consume the same map, so a
 * capability added here is enforced end-to-end by the type system.
 */

export type Role = 'admin' | 'maintainer' | 'business';

export type Permission =
  | 'workspaces:read'
  | 'workspaces:manage'
  | 'repos:read'
  | 'repos:manage'
  | 'issues:read'
  | 'issues:act'
  | 'prs:read'
  | 'prs:act'
  | 'proposals:read'
  | 'proposals:create'
  | 'proposals:act'
  | 'specs:read'
  | 'specs:manage'
  | 'docs:read'
  | 'docs:manage'
  | 'pipelines:read'
  | 'pipelines:manage'
  | 'pipelines:run'
  | 'runs:read'
  | 'runs:act'
  | 'automations:manage'
  | 'reports:read'
  | 'skills:manage'
  | 'settings:manage'
  | 'users:manage';

const ALL_PERMISSIONS: readonly Permission[] = [
  'workspaces:read',
  'workspaces:manage',
  'repos:read',
  'repos:manage',
  'issues:read',
  'issues:act',
  'prs:read',
  'prs:act',
  'proposals:read',
  'proposals:create',
  'proposals:act',
  'specs:read',
  'specs:manage',
  'docs:read',
  'docs:manage',
  'pipelines:read',
  'pipelines:manage',
  'pipelines:run',
  'runs:read',
  'runs:act',
  'automations:manage',
  'reports:read',
  'skills:manage',
  'settings:manage',
  'users:manage',
];

/**
 * The capability grid. admin: everything. maintainer: day-to-day operation of
 * every area except instance administration (settings, workspace lifecycle).
 * business: proposals only (plus the reads needed to file one).
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  admin: ALL_PERMISSIONS,
  maintainer: ALL_PERMISSIONS.filter(
    (p) => p !== 'settings:manage' && p !== 'workspaces:manage' && p !== 'users:manage',
  ),
  business: ['workspaces:read', 'repos:read', 'proposals:read', 'proposals:create', 'specs:read', 'docs:read'],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export interface AuthUser {
  readonly username: string;
  /** How the user is shown in the UI; defaults to the username. */
  readonly displayName: string;
  readonly role: Role;
}

/** A managed account (admin-editable; passwords are scrypt hashes at rest). */
export interface UserRecord {
  /** Immutable login identifier. */
  readonly username: string;
  /** Modifiable display name shown across the UI; defaults to the username. */
  readonly displayName: string;
  readonly email: string;
  readonly role: Role;
  readonly disabled: boolean;
  readonly createdAt: number;
}

// ---------- DTOs ---------------------------------------------------------------

/** Instance branding shown pre-login and in the shell chrome. */
export interface InstanceBranding {
  /** Display name for this install; null → "Companion". */
  readonly name: string | null;
  /** Logo as a data: URL; null → the default letter tile. */
  readonly logo: string | null;
}

/** Public bootstrap: does this install still need first-boot onboarding? */
export interface AuthState {
  readonly setup: boolean;
  readonly version: string;
  readonly branding: InstanceBranding;
}

export interface SetupRequest {
  readonly username: string;
  readonly email: string;
  readonly password: string;
}

export interface CreateUserRequest {
  readonly username: string;
  readonly displayName?: string;
  readonly email?: string;
  readonly password: string;
  readonly role: Role;
}

export interface UpdateUserRequest {
  readonly displayName?: string;
  readonly email?: string;
  readonly password?: string;
  readonly role?: Role;
  readonly disabled?: boolean;
}

export interface LoginRequest {
  readonly username: string;
  readonly password: string;
}

export interface LoginResponse {
  readonly token: string;
  readonly user: AuthUser;
  /** Epoch ms when the session expires. */
  readonly expiresAt: number;
}

export interface SessionInfo {
  readonly user: AuthUser;
  readonly permissions: readonly Permission[];
}
