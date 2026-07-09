import { z } from 'zod';
import { defineRoutes, route, created } from '@companion/core/server';
import { AuthError } from './auth.js';
import type { AccountInfo, AuthState, LoginResponse, ProfileResponse, SessionInfo } from '../contract/index.js';

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,39}$/i;
const roleSchema = z.enum(['admin', 'maintainer', 'business']);

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
  const settings = ctx.services.get('settings');
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
        version: '0.3.0',
        branding: { name: settings.get('branding.name') || null, logo: settings.get('branding.logo') || null },
      }),
    }),
    route({
      method: 'POST',
      path: '/api/auth/setup',
      access: 'public',
      body: setupSchema,
      handler: ({ body }): LoginResponse => auth.setup(body.username, body.email, body.password),
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
          role: role === 'admin' || role === 'maintainer' || role === 'business' ? role : undefined,
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
      handler: ({ body }) => created({ user: auth.createUser(body) }),
    }),
    route({
      method: 'PATCH',
      path: '/api/users/:username',
      access: 'users:manage',
      body: updateUserSchema,
      handler: ({ params, body, user }) => {
        if (!user) throw new AuthError('authentication required', 401);
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
