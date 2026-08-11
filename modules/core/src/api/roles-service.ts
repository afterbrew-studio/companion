import type { Permission } from '@moxxy/companion-contracts';
import type { Logger } from '@moxxy/companion-services';
import type { AuditSink, RbacReader, RoleOverrides } from '@moxxy/companion-core/server';
import type { RoleDetail, RoleRecord } from '../contract/index.js';
import { AuthError } from './auth.js';
import type { RolesStore } from './roles-store.js';
import type { UsersStore } from './users-store.js';

/** A captured override slot; `null` means "there was no row", so an undo removes it. */
interface OverrideSlot {
  readonly role: string;
  readonly permission: string;
  readonly mode: 'grant' | 'revoke' | null;
}

const ROLE_ID_RE = /^[a-z][a-z0-9-]{1,39}$/;

/**
 * The permission that must never become unreachable. Losing it means nobody can
 * create users or fix roles through the API, which turns a misclick into a
 * database-surgery incident; `companion role repair` exists for when it happens
 * anyway.
 */
const KEYSTONE: Permission = 'users:manage' as Permission;

/**
 * Instance-level role administration. Modules grant capabilities to the built-in
 * roles; this is where an instance adds roles of its own and adjusts what any
 * role holds. Every mutation republishes the whole override set to the grid, so
 * the effective permissions change live for sessions already open.
 */
export class RolesService {
  constructor(
    private readonly roles: RolesStore,
    private readonly users: UsersStore,
    private readonly rbac: RbacReader,
    private readonly setRoles: (overrides: RoleOverrides) => void,
    private readonly auditSink: AuditSink,
    private readonly log: Logger,
  ) {}

  /** Push the stored roles into the grid. Called at registration and after every write. */
  publish(): void {
    this.setRoles(this.roles.snapshot());
  }

  list(): RoleRecord[] {
    return this.roles.list();
  }

  detail(id: string): RoleDetail {
    const role = this.roles.get(id);
    if (!role) throw new AuthError(`unknown role: ${id}`, 403);
    return {
      ...role,
      permissions: this.rbac.permissionsFor(id).sort(),
      defaults: this.rbac.baseline(id).sort(),
      overrides: this.roles.overridesFor(id).map((o) => ({ permission: o.permission, mode: o.mode })),
      userCount: this.roles.countUsers(id),
    };
  }

  create(actor: string, input: { id: string; title: string; description?: string; from?: string }): RoleRecord {
    if (!ROLE_ID_RE.test(input.id)) {
      throw new AuthError('role id must be lowercase letters, digits or dashes (2-40 chars)', 403);
    }
    if (this.roles.get(input.id)) throw new AuthError(`role ${input.id} already exists`, 403);
    this.roles.create(input);
    // Cloning copies the SOURCE's effective permissions as explicit grants, not
    // its override rows: a custom role has no module grants to build on, so the
    // grants must be materialised or the clone would come out empty.
    if (input.from) {
      const source = this.roles.get(input.from);
      if (!source) {
        this.roles.delete(input.id);
        throw new AuthError(`unknown role to clone: ${input.from}`, 403);
      }
      for (const p of this.rbac.permissionsFor(input.from)) this.roles.setOverride(input.id, p, 'grant');
    }
    this.publish();
    this.audit(actor, `created role '${input.id}'${input.from ? ` from '${input.from}'` : ''}`);
    return this.roles.get(input.id)!;
  }

  delete(actor: string, id: string): void {
    const role = this.requireRole(id);
    if (role.builtin) throw new AuthError(`'${id}' is a built-in role and cannot be deleted`, 403);
    const users = this.roles.countUsers(id);
    if (users > 0) throw new AuthError(`${users} user(s) still hold '${id}'; reassign them first`, 403);
    this.roles.delete(id);
    this.publish();
    this.audit(actor, `deleted role '${id}'`);
  }

  grant(actor: string, id: string, permissions: readonly string[]): RoleDetail {
    return this.adjust(actor, id, permissions, 'grant');
  }

  revoke(actor: string, id: string, permissions: readonly string[]): RoleDetail {
    return this.adjust(actor, id, permissions, 'revoke');
  }

  /** Drop the override entirely, so the role falls back to what its modules grant. */
  reset(actor: string, id: string, permissions: readonly string[]): RoleDetail {
    this.requireRole(id);
    const undo = this.snapshotOf(id, permissions);
    for (const p of permissions) this.roles.clearOverride(id, p);
    this.commit(undo, `resetting ${permissions.join(', ')} on '${id}'`);
    this.audit(actor, `reset ${permissions.join(', ')} on '${id}'`);
    return this.detail(id);
  }

  private adjust(actor: string, id: string, permissions: readonly string[], mode: 'grant' | 'revoke'): RoleDetail {
    this.requireRole(id);
    const known = new Set(this.rbac.catalog().map((p) => p.id as string));
    const undo = this.snapshotOf(id, permissions);
    for (const p of permissions) {
      // Grant and revoke validate alike: an id no enabled module declares is a
      // typo, and an unvalidated revoke would persist a junk override row.
      if (!known.has(p)) throw new AuthError(`no enabled module declares '${p}'`, 403);
      this.roles.setOverride(id, p, mode);
    }
    this.commit(undo, `${mode} of ${permissions.join(', ')} on '${id}'`);
    this.audit(actor, `${mode} ${permissions.join(', ')} on '${id}'`);
    return this.detail(id);
  }

  /** The prior override state of the pairs about to change, for an exact undo. */
  private snapshotOf(id: string, permissions: readonly string[]): OverrideSlot[] {
    const current = this.roles.overridesFor(id);
    return permissions.map((p) => current.find((o) => o.permission === p) ?? { role: id, permission: p, mode: null });
  }

  /**
   * Publish, then check the keystone, and UNDO the write if it was violated.
   * The check has to run after the write because only the grid knows a change's
   * effective outcome (module grants, implies expansion and disabled owners all
   * feed into it); simulating that here would mean reimplementing the fold, and
   * a fold that drifts from the real one is worse than no check at all.
   */
  private commit(undo: readonly OverrideSlot[], what: string): void {
    this.publish();
    if (this.usersHolding(KEYSTONE) > 0) return;
    for (const o of undo) {
      if (o.mode === null) this.roles.clearOverride(o.role, o.permission);
      else this.roles.setOverride(o.role, o.permission, o.mode);
    }
    this.publish();
    throw new AuthError(`refusing ${what}: no enabled user would be able to manage users afterwards`, 403);
  }

  /**
   * Enabled accounts whose current role effectively holds `permission`. Users
   * hold exactly one role, so the roles are classified first (a handful) and
   * the users counted in one query. A role the grid no longer knows holds
   * nothing, exactly as the per-user `rbac.has` scan answered.
   */
  usersHolding(permission: Permission): number {
    const holding = this.rbac.roles().filter((role) => this.rbac.has(role, permission));
    return this.users.countEnabledByRoles(holding);
  }

  private requireRole(id: string): RoleRecord {
    const role = this.roles.get(id);
    if (!role) throw new AuthError(`unknown role: ${id}`, 403);
    return role;
  }

  /**
   * A role edit is a decision no single route describes (`POST
   * /api/roles/:id/permissions` says nothing about which permission moved), so
   * it carries its own detail alongside the router's own record.
   */
  private audit(actor: string, what: string): void {
    this.auditSink.record({
      at: Date.now(),
      actor,
      action: 'rbac.change',
      access: 'users:manage',
      status: 200,
      module: 'core',
      detail: what,
    });
    this.log.info(`[audit] rbac: ${actor} ${what}`);
  }
}
