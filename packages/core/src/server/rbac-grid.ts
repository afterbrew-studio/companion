import type { BuiltinRole, Role } from '@moxxy/companion-types';
import { BUILTIN_ROLES, isBuiltinRole } from '@moxxy/companion-types';
import type { AuthUser, ModuleAcl, Permission } from '@moxxy/companion-contracts';
import { buildRolePermissions } from '@moxxy/companion-contracts';
import type { ModuleId } from '../manifest.js';

/** One enabled module's ACL slice, tagged with its owner so the grid can attribute a permission. */
export interface AclSource {
  readonly id: ModuleId;
  readonly acl: ModuleAcl;
}

/** A declared permission and the module that owns it. */
export interface PermissionEntry {
  readonly id: Permission;
  readonly title: string;
  readonly owner: ModuleId;
  readonly implies: readonly Permission[];
}

/** One instance-level adjustment on top of what the modules grant. */
export interface RoleOverride {
  readonly role: Role;
  readonly permission: Permission;
  readonly mode: 'grant' | 'revoke';
}

/**
 * The instance's own role definitions. Owned and persisted by module-core; the
 * grid only folds them. Built-in roles are always present even if the store is
 * empty, so an install with no customisation behaves exactly as before.
 */
export interface RoleOverrides {
  readonly roles: readonly Role[];
  readonly entries: readonly RoleOverride[];
}

/** How a role came to hold (or not hold) a permission. */
export interface AclExplanation {
  readonly permission: Permission;
  readonly role: Role;
  readonly granted: boolean;
  /** null when no ENABLED module declares this permission. */
  readonly owner: ModuleId | null;
  readonly title: string | null;
  /**
   * Modules whose `grants` list this permission for the role. Normally just the
   * owner, but a module may grant a permission it does not declare, which the
   * fold accepts silently, so attribute every source rather than assuming one.
   */
  readonly grantedBy: readonly { readonly module: ModuleId; readonly kind: 'explicit' | 'wildcard' }[];
  /** Granted permissions whose `implies` chain reaches this one. */
  readonly impliedBy: readonly Permission[];
  /** The instance override touching this pair, if any. Beats every module grant. */
  readonly override: 'grant' | 'revoke' | null;
}

/** Read side of the grid, handed to modules via `ctx.rbac`. */
export interface RbacReader {
  has(role: Role, permission: Permission): boolean;
  /** Account RBAC intersected with the authority carried by this credential. */
  allows(user: AuthUser, permission: Permission): boolean;
  permissionsFor(role: Role): Permission[];
  /** Every permission the enabled modules declare, with its owning module. */
  catalog(): readonly PermissionEntry[];
  /** Provenance of one decision, for support and the `acl explain` command. */
  explain(role: Role, permission: Permission): AclExplanation;
  /**
   * What the ENABLED modules grant this role before any instance override.
   * Empty for a custom role, which has no module grants to build on. The admin
   * surface needs it to tell "granted by default" from "granted by an override",
   * which is what makes a permission toggle produce `revoke` in one case and
   * `reset` in the other instead of accumulating meaningless rows.
   */
  baseline(role: Role): Permission[];
  /** Every role this instance knows: the built-ins plus any custom ones. */
  roles(): readonly Role[];
  /** True when the role exists. An unknown role holds nothing. */
  hasRole(role: Role): boolean;
}

/**
 * The live effective capability grid, assembled from the ENABLED modules' ACL
 * slices. Rebuilt at boot and on every enable/disable so disabling a module
 * drops its permissions immediately. module-core's `Auth` queries this instead
 * of a static `ROLE_PERMISSIONS` value.
 */
export class RbacGrid implements RbacReader {
  private grid = new Map<Role, ReadonlySet<Permission>>();
  /** Retained so a decision can be attributed to the module that caused it. */
  private sources: readonly AclSource[] = [];
  /** Built-ins until module-core loads the stored roles, so boot is never role-less. */
  private overrides: RoleOverrides = { roles: BUILTIN_ROLES, entries: [] };
  /** The module-granted layer, kept so `baseline()` can answer without refolding. */
  private base: Record<BuiltinRole, ReadonlySet<Permission>> = { admin: new Set(), maintainer: new Set(), business: new Set() };

  constructor() {
    this.recompute();
  }

  /** Kernel: the enabled modules changed. */
  rebuild(sources: readonly AclSource[]): void {
    this.sources = sources;
    this.recompute();
  }

  /** module-core: the stored roles or grant overrides changed. */
  setOverrides(overrides: RoleOverrides): void {
    this.overrides = overrides;
    this.recompute();
  }

  /**
   * base (module grants for built-in roles, implies already expanded)
   *   ∪ instance grants (implies expanded)
   *   \ instance revokes            ← last, so an explicit revoke always wins
   *   ∩ permissions the ENABLED modules declare
   *
   * The final intersection is what makes a disabled module's permissions vanish
   * from every role while its override rows stay in the database, so enabling it
   * again restores exactly what was configured.
   */
  private recompute(): void {
    const base = buildRolePermissions(this.sources.map((s) => s.acl));
    this.base = base;
    const declared = new Set(this.catalog().map((p) => p.id));
    const implied = new Map<Permission, readonly Permission[]>();
    for (const s of this.sources) {
      for (const p of s.acl.permissions) if (p.implies?.length) implied.set(p.id, p.implies);
    }
    const expand = (perm: Permission, into: Set<Permission>): void => {
      if (into.has(perm)) return;
      into.add(perm);
      for (const dep of implied.get(perm) ?? []) expand(dep, into);
    };

    const next = new Map<Role, ReadonlySet<Permission>>();
    for (const role of this.overrides.roles) {
      const set = new Set<Permission>(isBuiltinRole(role) ? base[role] : []);
      for (const o of this.overrides.entries) {
        if (o.role === role && o.mode === 'grant') expand(o.permission, set);
      }
      for (const o of this.overrides.entries) {
        if (o.role === role && o.mode === 'revoke') set.delete(o.permission);
      }
      for (const p of [...set]) if (!declared.has(p)) set.delete(p);
      next.set(role, set);
    }
    this.grid = next;
  }

  has(role: Role, permission: Permission): boolean {
    return this.grid.get(role)?.has(permission) ?? false;
  }

  allows(user: AuthUser, permission: Permission): boolean {
    return (
      this.has(user.role, permission)
      && (user.permissionScope === undefined || user.permissionScope.includes(permission))
    );
  }

  permissionsFor(role: Role): Permission[] {
    return [...(this.grid.get(role) ?? [])];
  }

  baseline(role: Role): Permission[] {
    if (!isBuiltinRole(role)) return [];
    const declared = new Set(this.catalog().map((p) => p.id));
    return [...this.base[role]].filter((p) => declared.has(p));
  }

  roles(): readonly Role[] {
    return [...this.grid.keys()];
  }

  hasRole(role: Role): boolean {
    return this.grid.has(role);
  }

  catalog(): readonly PermissionEntry[] {
    return this.sources.flatMap((s) =>
      s.acl.permissions.map((p) => ({ id: p.id, title: p.title, owner: s.id, implies: p.implies ?? [] })),
    );
  }

  explain(role: Role, permission: Permission): AclExplanation {
    const entry = this.catalog().find((p) => p.id === permission);
    const grantedBy: { module: ModuleId; kind: 'explicit' | 'wildcard' }[] = [];
    // Module grants only ever name a built-in role; a custom role's capabilities
    // come entirely from the override rows below.
    if (isBuiltinRole(role)) {
      for (const s of this.sources) {
        const grant = s.acl.grants[role as BuiltinRole];
        if (!grant) continue;
        if (grant === '*') {
          if (s.acl.permissions.some((p) => p.id === permission)) grantedBy.push({ module: s.id, kind: 'wildcard' });
        } else if (grant.includes(permission)) grantedBy.push({ module: s.id, kind: 'explicit' });
      }
    }
    const override = this.overrides.entries.find((o) => o.role === role && o.permission === permission);
    return {
      permission,
      role,
      granted: this.has(role, permission),
      owner: entry?.owner ?? null,
      title: entry?.title ?? null,
      grantedBy,
      impliedBy: this.impliedBy(role, permission),
      override: override?.mode ?? null,
    };
  }

  /** Granted permissions that reach `target` through `implies`, transitively. */
  private impliedBy(role: Role, target: Permission): Permission[] {
    const catalog = this.catalog();
    const reaches = (from: Permission, seen: Set<Permission>): boolean => {
      if (seen.has(from)) return false;
      seen.add(from);
      const implies = catalog.find((p) => p.id === from)?.implies ?? [];
      return implies.includes(target) || implies.some((next) => reaches(next, seen));
    };
    return catalog
      .filter((p) => p.id !== target && this.has(role, p.id) && reaches(p.id, new Set()))
      .map((p) => p.id);
  }

  /** Snapshot of every role's granted permissions (for parity assertions / debugging). */
  snapshot(): Record<Role, Permission[]> {
    return Object.fromEntries([...this.grid].map(([role, perms]) => [role, [...perms]]));
  }
}
