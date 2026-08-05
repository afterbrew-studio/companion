import type { Role } from '@moxxy/companion-types';
import type { Permission } from './registries.js';
import type { RouteAccess } from './access.js';

/** Authority carried by one session token; omitted on AuthUser means full. */
export type SessionAccess = 'full' | 'read-only';

/**
 * Presentation-only menu preset for the application chrome. It never grants access:
 * RBAC still decides which routes and actions exist for the signed-in user.
 * `auto` derives the most useful preset from the user's role/capabilities while
 * the explicit values let somebody switch hats without changing their role.
 */
export const NAV_AUDIENCES = ['business', 'developer', 'admin'] as const;
export const NAV_PERSPECTIVES = ['auto', ...NAV_AUDIENCES] as const;
export type NavigationPerspective = (typeof NAV_PERSPECTIVES)[number];
export type NavigationAudience = (typeof NAV_AUDIENCES)[number];

/** One personal deviation from a menu preset's module-authored defaults. */
export interface NavigationPageOverride {
  readonly perspective: NavigationAudience;
  readonly key: string;
  readonly visible: boolean;
}

/** The invoking user resolved from a session token; null only on `public` routes. */
export interface AuthUser {
  readonly username: string;
  /** How the user is shown in the UI; defaults to the username. */
  readonly displayName: string;
  readonly role: Role;
  /** Internal delegated sessions may inspect state but cannot mutate routes by default. */
  readonly sessionAccess?: SessionAccess;
  /**
   * API credentials carry an explicit capability ceiling. Absence means an
   * ordinary interactive/internal session; an empty array means authenticated
   * but permitted to reach no permission-gated route.
   */
  readonly permissionScope?: readonly Permission[];
}

/**
 * Verifies session tokens and enforces capabilities. Implemented by
 * module-core's `Auth`; the kernel dispatch layer depends only on this
 * interface (dependency inversion — core-the-framework never imports auth).
 */
export interface Authenticator {
  verify(token: string | null): AuthUser | null;
  /** Throw (401/403) unless `user` holds `permission`. Never called for public/any routes. */
  require(user: AuthUser | null, permission: Permission): void;
}
