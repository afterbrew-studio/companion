import type { Role } from '@companion/types';
import { ROLES } from '@companion/types';
import type { ModuleAcl, Permission } from '@companion/contracts';
import { buildRolePermissions } from '@companion/contracts';

/** Read side of the grid, handed to modules via `ctx.rbac` (module-core's Auth). */
export interface RbacReader {
  has(role: Role, permission: Permission): boolean;
  permissionsFor(role: Role): Permission[];
}

/**
 * The live effective capability grid, assembled from the ENABLED modules' ACL
 * slices. Rebuilt at boot and on every enable/disable so disabling a module
 * drops its permissions immediately. module-core's `Auth` queries this instead
 * of a static `ROLE_PERMISSIONS` value.
 */
export class RbacGrid implements RbacReader {
  private grid: Record<Role, ReadonlySet<Permission>> = {
    admin: new Set(),
    maintainer: new Set(),
    business: new Set(),
  };

  rebuild(acls: readonly ModuleAcl[]): void {
    this.grid = buildRolePermissions(acls);
  }

  has(role: Role, permission: Permission): boolean {
    return this.grid[role].has(permission);
  }

  permissionsFor(role: Role): Permission[] {
    return [...this.grid[role]];
  }

  /** Snapshot of every role's granted permissions (for parity assertions / debugging). */
  snapshot(): Record<Role, Permission[]> {
    const out = {} as Record<Role, Permission[]>;
    for (const role of ROLES) out[role] = [...this.grid[role]];
    return out;
  }
}
