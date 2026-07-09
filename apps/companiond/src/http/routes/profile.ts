import { z } from 'zod';
import type { AccountInfo, ProfileResponse } from '@companion/contract';
import { route, type CompiledRoute } from '../router.js';
import { AuthError } from '../../auth/auth.js';
import type { ApiDeps } from '../deps.js';

const scopeEnum = z.enum(['workspace', 'global']);

const updateProfileSchema = z.object({
  // null clears the override so the instance default applies again.
  notificationScope: scopeEnum.nullable().optional(),
});

const updateAccountSchema = z
  .object({
    displayName: z.string().trim().min(1).max(60).optional(),
    email: z.string().email().max(200).optional(),
    currentPassword: z.string().min(1).max(500).optional(),
    newPassword: z.string().min(8).max(500).optional(),
  })
  // Changing the password requires proving you know the current one.
  .refine((b) => b.newPassword === undefined || b.currentPassword !== undefined, {
    message: 'currentPassword is required to set a new password',
    path: ['currentPassword'],
  });

/** The signed-in user's own settings (any role): inbox scope override + more. */
export function profileRoutes(deps: ApiDeps): CompiledRoute[] {
  const settings = deps.store.settings;
  const respond = (username: string): ProfileResponse => ({
    profile: { notificationScope: settings.userNotificationScope(username) },
    defaults: { notificationScope: settings.notificationDefaultScope() },
  });

  return [
    route({
      method: 'GET',
      path: '/api/profile',
      access: 'any',
      handler: ({ user }): ProfileResponse => {
        if (!user) throw new AuthError('authentication required', 401);
        return respond(user.username);
      },
    }),

    route({
      method: 'PUT',
      path: '/api/profile',
      access: 'any',
      body: updateProfileSchema,
      handler: ({ user, body }): ProfileResponse => {
        if (!user) throw new AuthError('authentication required', 401);
        if ('notificationScope' in body) {
          settings.setUserNotificationScope(user.username, body.notificationScope ?? null);
        }
        return respond(user.username);
      },
    }),

    route({
      method: 'GET',
      path: '/api/account',
      access: 'any',
      handler: ({ user }): { account: AccountInfo } => {
        if (!user) throw new AuthError('authentication required', 401);
        return { account: deps.auth.ownAccount(user.username) };
      },
    }),

    route({
      method: 'PUT',
      path: '/api/account',
      access: 'any',
      body: updateAccountSchema,
      handler: ({ user, body }): { account: AccountInfo } => {
        if (!user) throw new AuthError('authentication required', 401);
        return { account: deps.auth.updateOwnAccount(user.username, body) };
      },
    }),
  ];
}
