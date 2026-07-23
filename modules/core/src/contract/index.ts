import type { Role } from '@companion/types';
import type { AuthUser, Permission } from '@companion/contracts';
import type { Auth } from '../api/auth.js';
import type { SettingsStore } from '../api/settings-store.js';

/**
 * module-core contract slice — identity + settings DTOs, plus the `declare
 * module` augmentations that open the shared registries with this module's
 * capabilities and register its services for typed cross-module access.
 */

declare module '@companion/contracts' {
  interface PermissionRegistry {
    'users:manage': true;
    'settings:manage': true;
  }
  interface ServiceMap {
    core: Auth;
    settings: SettingsStore;
  }
  interface BusEvents {
    /** First-boot onboarding created the installation's primary admin. */
    'auth.setup.completed': { readonly username: string };
  }
}

/** A managed account (admin-editable; passwords are scrypt hashes at rest). */
export interface UserRecord {
  readonly username: string;
  readonly displayName: string;
  readonly email: string;
  readonly role: Role;
  readonly disabled: boolean;
  readonly createdAt: number;
}

/** Instance branding shown pre-login and in the shell chrome. */
export interface InstanceBranding {
  readonly name: string | null;
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

/** How the inbox is scoped: the active workspace only, or every accessible workspace. */
export type NotificationScope = 'workspace' | 'global';

export interface SessionInfo {
  readonly user: AuthUser;
  readonly permissions: readonly Permission[];
  readonly notificationScope: NotificationScope;
}

/** A user's own editable settings, distinct from the admin-managed account. */
export interface UserProfile {
  /** Inbox scope override; null = inherit the instance default. */
  readonly notificationScope: NotificationScope | null;
}

/** GET /api/profile — the user's overrides plus the defaults a null falls back to. */
export interface ProfileResponse {
  readonly profile: UserProfile;
  readonly defaults: { readonly notificationScope: NotificationScope };
}

export interface UpdateProfileRequest {
  readonly notificationScope?: NotificationScope | null;
}

/** The signed-in user's own account, as shown on their profile page. */
export interface AccountInfo {
  readonly username: string;
  readonly displayName: string;
  readonly email: string;
  readonly role: Role;
}

export interface UpdateAccountRequest {
  readonly displayName?: string;
  readonly email?: string;
  readonly currentPassword?: string;
  readonly newPassword?: string;
}
