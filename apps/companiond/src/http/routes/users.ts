import { z } from 'zod';
import { route, created, type CompiledRoute } from '../router.js';
import { AuthError } from '../../auth/auth.js';
import type { ApiDeps } from '../deps.js';

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,39}$/i;
const roleSchema = z.enum(['admin', 'maintainer', 'business']);

const createUserSchema = z.object({
  username: z.string().regex(USERNAME_RE, 'letters, digits, dots, dashes (2-40 chars)'),
  email: z.string().email().max(200).optional(),
  password: z.string().min(8).max(500),
  role: roleSchema,
});

const updateUserSchema = z.object({
  email: z.string().email().max(200).optional(),
  password: z.string().min(8).max(500).optional(),
  role: roleSchema.optional(),
  disabled: z.boolean().optional(),
});

/** User management (admin): the accounts + roles behind the login screen. */
export function userRoutes(deps: ApiDeps): CompiledRoute[] {
  return [
    route({
      method: 'GET',
      path: '/api/users',
      access: 'users:manage',
      handler: ({ query }) => {
        const role = query.get('role');
        return deps.store.searchUsers({
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
      handler: ({ body }) => created({ user: deps.auth.createUser(body) }),
    }),

    route({
      method: 'PATCH',
      path: '/api/users/:username',
      access: 'users:manage',
      body: updateUserSchema,
      handler: ({ params, body, user }) => {
        if (!user) throw new AuthError('authentication required', 401);
        return { user: deps.auth.updateUser(params.username, body, user) };
      },
    }),

    route({
      method: 'DELETE',
      path: '/api/users/:username',
      access: 'users:manage',
      handler: ({ params, user }) => {
        if (!user) throw new AuthError('authentication required', 401);
        deps.auth.deleteUser(params.username, user);
        return { ok: true };
      },
    }),
  ];
}
