import { z } from 'zod';
import { APP_VERSION } from '@moxxy/companion-core';
import { defineRoutes, route, created, badRequest, document } from '@moxxy/companion-core/server';
import type { Permission } from '@moxxy/companion-contracts';
import { AuthError } from './auth.js';
import type {
  AccountInfo,
  AclExplained,
  AclMap,
  AuthState,
  LoginResponse,
  ProfileResponse,
  SessionInfo,
} from '../contract/index.js';

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,39}$/i;
// Roles are instance data now, so membership is checked against the live grid
// in the handler rather than pinned to a compile-time enum.
const roleSchema = z.string().trim().min(2).max(40);

const loginSchema = z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(500) });
const setupSchema = z.object({
  username: z.string().regex(USERNAME_RE, 'letters, digits, dots, dashes (2-40 chars)'),
  email: z.string().email().max(200),
  password: z.string().min(8).max(500),
});
const createUserSchema = z.object({
  username: z.string().regex(USERNAME_RE, 'letters, digits, dots, dashes (2-40 chars)'),
  displayName: z.string().trim().min(1).max(60).optional(),
  email: z.string().email().max(200).optional(),
  password: z.string().min(8).max(500),
  role: roleSchema,
});
const updateUserSchema = z.object({
  displayName: z.string().trim().min(1).max(60).optional(),
  email: z.string().email().max(200).optional(),
  password: z.string().min(8).max(500).optional(),
  role: roleSchema.optional(),
  disabled: z.boolean().optional(),
});
const createRoleSchema = z.object({
  id: z.string().trim().min(2).max(40),
  title: z.string().trim().min(1).max(60),
  description: z.string().trim().max(200).optional(),
  /** Clone the source's EFFECTIVE permissions as explicit grants. */
  from: roleSchema.optional(),
});
const adjustRoleSchema = z.object({
  mode: z.enum(['grant', 'revoke', 'reset']),
  permissions: z.array(z.string().trim().min(3).max(80)).min(1).max(200),
});
const scopeEnum = z.enum(['workspace', 'global']);
const updateProfileSchema = z.object({ notificationScope: scopeEnum.nullable().optional() });
const updateAccountSchema = z
  .object({
    displayName: z.string().trim().min(1).max(60).optional(),
    email: z.string().email().max(200).optional(),
    currentPassword: z.string().min(1).max(500).optional(),
    newPassword: z.string().min(8).max(500).optional(),
  })
  .refine((b) => b.newPassword === undefined || b.currentPassword !== undefined, {
    message: 'currentPassword is required to set a new password',
    path: ['currentPassword'],
  });

export default defineRoutes((ctx) => {
  const auth = ctx.services.get('core');
  const roles = ctx.services.get('roles');
  const audit = ctx.services.get('audit');
  const settings = ctx.services.get('settings');
  /** A user may only be given a role that exists; the schema cannot know the set. */
  const requireRole = (role: string | undefined): void => {
    if (role !== undefined && !ctx.rbac.hasRole(role)) throw badRequest(`unknown role: ${role}`);
  };
  const profileResponse = (username: string): ProfileResponse => ({
    profile: { notificationScope: settings.userNotificationScope(username) },
    defaults: { notificationScope: settings.notificationDefaultScope() },
  });

  return [
    // ---------- auth ----------
    route({
      method: 'GET',
      path: '/api/auth/state',
      access: 'public',
      handler: (): AuthState => ({
        setup: auth.setupNeeded(),
        version: APP_VERSION,
        branding: { name: settings.get('branding.name') || null, logo: settings.get('branding.logo') || null },
        githubHost: ctx.config.github.host,
        providers: auth.providers(),
      }),
    }),
    route({
      method: 'POST',
      path: '/api/auth/setup',
      access: 'public',
      body: setupSchema,
      handler: ({ body }): LoginResponse => {
        const session = auth.setup(body.username, body.email, body.password);
        ctx.bus.emit('auth.setup.completed', { username: session.user.username });
        return session;
      },
    }),
    route({
      method: 'POST',
      path: '/api/auth/login',
      access: 'public',
      body: loginSchema,
      handler: ({ body }): LoginResponse => auth.login(body.username, body.password),
    }),
    route({
      method: 'POST',
      path: '/api/auth/logout',
      access: 'any',
      handler: ({ token }) => {
        if (token) auth.logout(token);
        return { ok: true };
      },
    }),
    route({
      method: 'GET',
      path: '/api/auth/me',
      access: 'any',
      handler: ({ user }): SessionInfo => {
        if (!user) throw new AuthError('authentication required', 401);
        return auth.sessionInfo(user);
      },
    }),

    // ---------- user management (admin) ----------
    route({
      method: 'GET',
      path: '/api/users',
      access: 'users:manage',
      handler: ({ query }) => {
        const role = query.get('role');
        return auth.searchUsers({
          q: query.get('q') ?? undefined,
          role: role && ctx.rbac.hasRole(role) ? role : undefined,
          limit: Number(query.get('limit')) || undefined,
          offset: Number(query.get('offset')) || undefined,
        });
      },
    }),
    route({
      method: 'POST',
      path: '/api/users',
      access: 'users:manage',
      body: createUserSchema,
      handler: ({ body }) => {
        requireRole(body.role);
        return created({ user: auth.createUser(body) });
      },
    }),
    route({
      method: 'PATCH',
      path: '/api/users/:username',
      access: 'users:manage',
      body: updateUserSchema,
      handler: ({ params, body, user }) => {
        if (!user) throw new AuthError('authentication required', 401);
        requireRole(body.role);
        return { user: auth.updateUser(params.username, body, user) };
      },
    }),
    route({
      method: 'DELETE',
      path: '/api/users/:username',
      access: 'users:manage',
      handler: ({ params, user }) => {
        if (!user) throw new AuthError('authentication required', 401);
        auth.deleteUser(params.username, user);
        return { ok: true };
      },
    }),

    // ---------- audit trail ----------
    route({
      // Keyset-paged, newest first: `before` is the last id the caller saw.
      method: 'GET',
      path: '/api/audit',
      access: 'audit:read',
      handler: ({ query }) => {
        const num = (k: string): number | undefined => {
          const v = Number(query.get(k));
          return Number.isFinite(v) && query.get(k) !== null ? v : undefined;
        };
        const entries = audit.list({
          actor: query.get('actor') ?? undefined,
          module: query.get('module') ?? undefined,
          since: num('since'),
          until: num('until'),
          before: num('before'),
          limit: num('limit'),
        });
        return { entries, nextBefore: entries.length ? entries[entries.length - 1]!.id : null };
      },
    }),
    route({
      // "Get our data out" as one NDJSON stream: one JSON object per line, so a
      // year of entries neither builds a giant array in memory nor needs paging
      // logic in whatever ingests it.
      method: 'GET',
      path: '/api/audit/export',
      access: 'audit:read',
      handler: ({ query }) => {
        const since = Number(query.get('since'));
        let before: number | undefined;
        const lines: string[] = [];
        for (;;) {
          const page = audit.list({ since: Number.isFinite(since) ? since : undefined, before, limit: 1000 });
          if (!page.length) break;
          for (const e of page) lines.push(JSON.stringify(e));
          before = page[page.length - 1]!.id;
        }
        return document(`${lines.join('\n')}\n`, 'application/x-ndjson', 'companion-audit.ndjson');
      },
    }),

    // ---------- roles (instance-defined; modules only grant to the built-ins) ----------
    route({
      method: 'GET',
      path: '/api/roles',
      access: 'users:manage',
      handler: () => ({ roles: roles.list() }),
    }),
    route({
      method: 'GET',
      path: '/api/roles/:id',
      access: 'users:manage',
      handler: ({ params }) => ({ role: roles.detail(params.id) }),
    }),
    route({
      method: 'POST',
      path: '/api/roles',
      access: 'users:manage',
      body: createRoleSchema,
      handler: ({ body, user }) => created({ role: roles.create(user!.username, body) }),
    }),
    route({
      method: 'DELETE',
      path: '/api/roles/:id',
      access: 'users:manage',
      handler: ({ params, user }) => {
        roles.delete(user!.username, params.id);
        return { ok: true };
      },
    }),
    route({
      // grant / revoke pin the answer for this role; reset drops the override so
      // the role falls back to whatever its modules grant.
      method: 'POST',
      path: '/api/roles/:id/permissions',
      access: 'users:manage',
      body: adjustRoleSchema,
      handler: ({ params, body, user }) => {
        const actor = user!.username;
        const apply = { grant: roles.grant, revoke: roles.revoke, reset: roles.reset }[body.mode];
        return { role: apply.call(roles, actor, params.id, body.permissions) };
      },
    }),

    // ---------- ACL introspection (who may do what, and why) ----------
    route({
      // The grid as the kernel computes it right now: a disabled module's
      // permissions are absent, which is the whole point of asking the daemon
      // instead of reading acl.ts.
      method: 'GET',
      path: '/api/acl',
      access: 'users:manage',
      handler: (): AclMap => ({
        roles: ctx.rbac.roles().map((id) => ({ id, permissions: ctx.rbac.permissionsFor(id).sort() })),
        permissions: ctx.rbac
          .catalog()
          .map((p) => ({ ...p, grants: ctx.rbac.roles().filter((r) => ctx.rbac.has(r, p.id)) }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      }),
    }),
    route({
      method: 'GET',
      path: '/api/acl/explain',
      access: 'users:manage',
      handler: ({ query }): AclExplained => {
        const subject = query.get('subject')?.trim();
        const permission = query.get('permission')?.trim();
        if (!subject || !permission) throw badRequest('subject and permission are required');
        // A subject is a role name, or a username whose CURRENT role is resolved
        // live: explaining against a stale role would be worse than not answering.
        const isRole = ctx.rbac.hasRole(subject);
        const role = isRole ? subject : auth.userRole(subject);
        if (!role) throw badRequest(`'${subject}' is neither a role nor a known user`);
        // Deliberately unvalidated against the union: answering "nothing
        // declares that" is the most useful reply to a typo.
        const explained = ctx.rbac.explain(role, permission as Permission);
        // The grid only knows ENABLED modules, so a permission belonging to a
        // disabled one looks identical to a typo. The catalog does know, and
        // "install slop" is a far better answer than "no such permission".
        const dormant = explained.owner
          ? null
          : ctx.modules.list().find((m) => m.permissions.includes(permission));
        return {
          ...explained,
          owner: explained.owner ?? dormant?.id ?? null,
          ownerEnabled: explained.owner !== null,
          ownerInstalled: explained.owner !== null || (dormant?.installed ?? false),
          username: isRole ? null : subject,
        };
      },
    }),

    // ---------- modules (runtime toggles; the SPA bootstraps from the list) ----------
    route({
      method: 'GET',
      path: '/api/modules',
      access: 'any',
      handler: () => ({ modules: ctx.modules.list() }),
    }),
    route({
      method: 'POST',
      path: '/api/modules/:id/enable',
      access: 'modules:manage',
      handler: async ({ params }) => {
        await ctx.modules.enable(params.id);
        return { modules: ctx.modules.list() };
      },
    }),
    route({
      method: 'POST',
      path: '/api/modules/:id/disable',
      access: 'modules:manage',
      handler: async ({ params }) => {
        await ctx.modules.disable(params.id);
        return { modules: ctx.modules.list() };
      },
    }),
    route({
      method: 'POST',
      path: '/api/modules/:id/uninstall',
      access: 'modules:manage',
      handler: async ({ params }) => {
        await ctx.modules.uninstall(params.id);
        return { modules: ctx.modules.list() };
      },
    }),
    route({
      method: 'POST',
      path: '/api/modules/:id/install',
      access: 'modules:manage',
      body: z.object({ config: z.record(z.unknown()).optional() }),
      handler: async ({ params, body }) => {
        await ctx.modules.install(params.id, body.config);
        return { modules: ctx.modules.list() };
      },
    }),
    route({
      method: 'GET',
      path: '/api/modules/:id/config',
      access: 'modules:manage',
      handler: ({ params }) => ctx.modules.getConfig(params.id),
    }),
    route({
      method: 'PUT',
      path: '/api/modules/:id/config',
      access: 'modules:manage',
      body: z.object({ config: z.record(z.unknown()) }),
      handler: ({ params, body }) => {
        ctx.modules.setConfig(params.id, body.config);
        return ctx.modules.getConfig(params.id);
      },
    }),

    // ---------- self-service account + profile (any signed-in user) ----------
    route({
      method: 'GET',
      path: '/api/profile',
      access: 'any',
      handler: ({ user }): ProfileResponse => {
        if (!user) throw new AuthError('authentication required', 401);
        return profileResponse(user.username);
      },
    }),
    route({
      method: 'PUT',
      path: '/api/profile',
      access: 'any',
      body: updateProfileSchema,
      handler: ({ user, body }): ProfileResponse => {
        if (!user) throw new AuthError('authentication required', 401);
        if ('notificationScope' in body) settings.setUserNotificationScope(user.username, body.notificationScope ?? null);
        return profileResponse(user.username);
      },
    }),
    route({
      method: 'GET',
      path: '/api/account',
      access: 'any',
      handler: ({ user }): { account: AccountInfo } => {
        if (!user) throw new AuthError('authentication required', 401);
        return { account: auth.ownAccount(user.username) };
      },
    }),
    route({
      method: 'PUT',
      path: '/api/account',
      access: 'any',
      body: updateAccountSchema,
      handler: ({ user, body }): { account: AccountInfo } => {
        if (!user) throw new AuthError('authentication required', 401);
        return { account: auth.updateOwnAccount(user.username, body) };
      },
    }),
  ];
});
