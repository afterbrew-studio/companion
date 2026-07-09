import type { Role } from '@companion/types';
import type { Permission } from './registries.js';
import type { RouteAccess } from './access.js';

/** The invoking user resolved from a session token; null only on `public` routes. */
export interface AuthUser {
  readonly username: string;
  /** How the user is shown in the UI; defaults to the username. */
  readonly displayName: string;
  readonly role: Role;
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
