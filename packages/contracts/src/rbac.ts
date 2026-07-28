import type { BuiltinRole } from '@moxxy/companion-types';
import { BUILTIN_ROLES } from '@moxxy/companion-types';
import type { Permission } from './registries.js';

export interface PermissionSpec {
  readonly id: Permission;
  readonly title: string;
  readonly implies?: readonly Permission[];
}

/**
 * Built-in role → the permissions this module grants it, or `'*'` = all of this
 * module's permissions. Deliberately keyed by BUILT-IN role only: a module
 * cannot know the custom roles an instance defines, so custom roles are composed
 * from the permission catalogue by the instance instead (see RbacGrid overrides).
 */
export type RoleGrants = Partial<Record<BuiltinRole, readonly Permission[] | '*'>>;

export interface ModuleAcl {
  readonly permissions: readonly PermissionSpec[];
  readonly grants: RoleGrants;
}

/**
 * Fold the ACL slices of the ENABLED modules into the effective capability
 * grid. `'*'` grants every permission the module itself declares; `implies`
 * expands transitively. Called at boot and whenever a module is
 * enabled/disabled, so the grid always reflects exactly the live module set.
 */
export function buildRolePermissions(
  acls: readonly ModuleAcl[],
): Record<BuiltinRole, ReadonlySet<Permission>> {
  const implied = new Map<Permission, readonly Permission[]>();
  for (const acl of acls) {
    for (const p of acl.permissions) if (p.implies?.length) implied.set(p.id, p.implies);
  }
  const expand = (perm: Permission, into: Set<Permission>): void => {
    if (into.has(perm)) return;
    into.add(perm);
    for (const dep of implied.get(perm) ?? []) expand(dep, into);
  };

  const grid: Record<BuiltinRole, Set<Permission>> = {
    admin: new Set(),
    maintainer: new Set(),
    business: new Set(),
  };
  for (const acl of acls) {
    const own = acl.permissions.map((p) => p.id);
    for (const role of BUILTIN_ROLES) {
      const grant = acl.grants[role];
      if (!grant) continue;
      for (const p of grant === '*' ? own : grant) expand(p, grid[role]);
    }
  }
  return grid;
}

export function hasPermission(
  grid: Record<BuiltinRole, ReadonlySet<Permission>>,
  role: BuiltinRole,
  permission: Permission,
): boolean {
  return grid[role].has(permission);
}
