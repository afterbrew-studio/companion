import type { Role } from '@moxxy/companion-types';
import type { AuthUser, Permission } from '@moxxy/companion-contracts';
import type { ModuleArtifact, ModuleProvenance } from '@moxxy/companion-core/server';
import type { Supervisor } from '@moxxy/companion-services';
import type { Auth } from '../api/auth.js';
import type { RolesService } from '../api/roles-service.js';
import type { AuditStore } from '../api/audit-store.js';
import type { AuditForwarder } from '../api/audit-forwarder.js';

export type { AuditRecord } from '../api/audit-store.js';
export type { ForwarderState } from '../api/audit-forwarder.js';
import type { SettingsStore } from '../api/settings-store.js';

/**
 * module-core contract slice — identity + settings DTOs, plus the `declare
 * module` augmentations that open the shared registries with this module's
 * capabilities and register its services for typed cross-module access.
 */

declare module '@moxxy/companion-contracts' {
  interface PermissionRegistry {
    'users:manage': true;
    'settings:manage': true;
    'modules:manage': true;
    'modules:deploy': true;
    'audit:read': true;
  }
  interface ServiceMap {
    core: Auth;
    roles: RolesService;
    audit: AuditStore;
    /** The outbound audit stream; its state feeds the trail page's health line. */
    auditForwarder: AuditForwarder;
    settings: SettingsStore;
  }
  interface BusEvents {
    /** First-boot onboarding created the installation's primary admin. */
    'auth.setup.completed': { readonly username: string };
  }
}

/** A role this instance knows. Built-ins cannot be deleted; their grants are tunable. */
export interface RoleRecord {
  readonly id: Role;
  readonly title: string;
  readonly description: string;
  readonly builtin: boolean;
  readonly createdAt: number;
}

/** A role with everything the admin surface needs to render and edit it. */
export interface RoleDetail extends RoleRecord {
  /** Effective permissions right now: module grants, overrides applied, disabled owners dropped. */
  readonly permissions: readonly Permission[];
  /** What the modules grant this role before overrides; empty for a custom role. */
  readonly defaults: readonly Permission[];
  /** Instance adjustments on top of what the modules grant. */
  readonly overrides: readonly { readonly permission: Permission; readonly mode: 'grant' | 'revoke' }[];
  readonly userCount: number;
}

/** One declared capability and the module that owns it. */
export interface AclPermission {
  readonly id: Permission;
  readonly title: string;
  readonly owner: string;
  readonly implies: readonly Permission[];
  /** Roles that effectively hold it right now. */
  readonly grants: readonly Role[];
}

/** The live effective grid: exactly the permissions the ENABLED modules declare. */
export interface AclMap {
  readonly roles: readonly { readonly id: Role; readonly permissions: readonly Permission[] }[];
  readonly permissions: readonly AclPermission[];
}

/** Why a role does or does not hold a permission, for support and `acl explain`. */
export interface AclExplained {
  readonly permission: Permission;
  readonly role: Role;
  /** Set when the subject was a username rather than a role. */
  readonly username: string | null;
  readonly granted: boolean;
  /** Declaring module, even when it is disabled; null only when nothing declares it. */
  readonly owner: string | null;
  /** false ⇒ the owner is in this build but off, so the permission left the grid. */
  readonly ownerEnabled: boolean;
  /** Distinguishes "adopted but disabled" from "never installed" (the fix differs). */
  readonly ownerInstalled: boolean;
  readonly title: string | null;
  readonly grantedBy: readonly { readonly module: string; readonly kind: 'explicit' | 'wildcard' }[];
  readonly impliedBy: readonly Permission[];
  /** An instance override on this pair beats every module grant. */
  readonly override: 'grant' | 'revoke' | null;
}

// ---- out-of-tree module artifacts (the files in <home>/modules) ----

export type { ModuleArtifact, ModuleProvenance, Supervisor };

/**
 * One out-of-tree module as it is on disk right now, which is not the same
 * question as what the kernel has loaded: the external scan runs once at boot,
 * so files added since are real but dormant, and `loaded` is what says so.
 */
export interface ExternalModuleRecord extends ModuleArtifact {
  /** false = this daemon has not scanned these files, so a restart is still owed. */
  readonly loaded: boolean;
}

export interface ExternalModulesResponse {
  /** The directory the daemon scans, so "where is this" has an answer in the UI. */
  readonly root: string;
  readonly modules: readonly ExternalModuleRecord[];
  /** What is watching the daemon, which decides what restarting it does. */
  readonly supervisor: Supervisor;
}

/** What `POST /api/modules/add` obtained, with the ledger entry it wrote. */
export interface AddModuleResponse {
  readonly id: string;
  /** The version already there that this replaced, or null on a first add. */
  readonly replaced: string | null;
  /** ABI-check observations worth showing (external imports, server-only, …). */
  readonly notes: readonly string[];
  readonly provenance: ModuleProvenance;
}

export interface RemoveModuleResponse {
  readonly id: string;
  /** true = the kernel knew it, so migrations were rolled back and config wiped. */
  readonly uninstalled: boolean;
  /** false = there were no files under this id (already removed by hand). */
  readonly deleted: boolean;
}

/** What restarting did, so the UI can say whether Companion is coming back. */
export interface RestartResponse {
  readonly supervisor: Supervisor;
  /** true = nothing supervises this daemon, so it started its own successor. */
  readonly reexec: boolean;
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

/**
 * A way to sign in other than a local password. An identity module (OIDC, SAML)
 * registers one in its `onEnable`; the login page renders a button per entry.
 * Deliberately just a link: the whole handshake belongs to the module that
 * understands the protocol, and Companion only needs to know where to send the
 * browser.
 */
export interface AuthProvider {
  readonly id: string;
  readonly label: string;
  /** Where the browser goes to begin the handshake. */
  readonly startUrl: string;
}

/** Public bootstrap: does this install still need first-boot onboarding? */
export interface AuthState {
  readonly setup: boolean;
  readonly version: string;
  readonly branding: InstanceBranding;
  /**
   * Host for user-facing GitHub links (`github.com`, or a GitHub Enterprise
   * Server). Not a secret and needed before sign-in, so it rides the bootstrap
   * everyone already fetches rather than earning an endpoint of its own.
   */
  readonly githubHost: string;
  /** Alternative sign-in methods; empty on a local-accounts-only install. */
  readonly providers: readonly AuthProvider[];
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
