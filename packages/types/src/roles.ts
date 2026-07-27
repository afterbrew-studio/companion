/**
 * A role id. Open by design: the three built-ins below are seeded rows, and an
 * instance admin may compose further roles from the permission catalogue.
 *
 * Modules grant capabilities to the BUILT-IN roles only (see `RoleGrants`), so a
 * module never needs to know a custom role exists. Custom roles get their
 * permissions from the instance's own grant/revoke overrides, which is why
 * adding one requires no module change.
 */
export type Role = string;

/** Roles every install has. They cannot be deleted, but their grants are tunable. */
export type BuiltinRole = 'admin' | 'maintainer' | 'business';

export const BUILTIN_ROLES: readonly BuiltinRole[] = ['admin', 'maintainer', 'business'];

export const isBuiltinRole = (role: string): role is BuiltinRole =>
  (BUILTIN_ROLES as readonly string[]).includes(role);
