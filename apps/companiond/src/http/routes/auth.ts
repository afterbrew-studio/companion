import { z } from 'zod';
import type { AuthState, LoginResponse, SessionInfo } from '@companion/contract';
import { route, type CompiledRoute } from '../router.js';
import { AuthError } from '../../auth/auth.js';
import type { ApiDeps } from '../deps.js';

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,39}$/i;

const loginSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(500),
});

const setupSchema = z.object({
  username: z.string().regex(USERNAME_RE, 'letters, digits, dots, dashes (2-40 chars)'),
  email: z.string().email().max(200),
  password: z.string().min(8).max(500),
});

export function authRoutes(deps: ApiDeps): CompiledRoute[] {
  return [
    /** Public bootstrap: does this install still need first-boot onboarding? */
    route({
      method: 'GET',
      path: '/api/auth/state',
      access: 'public',
      handler: (): AuthState => ({ setup: deps.auth.setupNeeded(), version: '0.3.0' }),
    }),

    /** First-boot onboarding: create the admin account (clean installs only). */
    route({
      method: 'POST',
      path: '/api/auth/setup',
      access: 'public',
      body: setupSchema,
      handler: ({ body }): LoginResponse => deps.auth.setup(body.username, body.email, body.password),
    }),

    route({
      method: 'POST',
      path: '/api/auth/login',
      access: 'public',
      body: loginSchema,
      handler: ({ body }): LoginResponse => deps.auth.login(body.username, body.password),
    }),

    route({
      method: 'POST',
      path: '/api/auth/logout',
      access: 'any',
      handler: ({ token }) => {
        if (token) deps.auth.logout(token);
        return { ok: true };
      },
    }),

    route({
      method: 'GET',
      path: '/api/auth/me',
      access: 'any',
      handler: ({ user }): SessionInfo => {
        if (!user) throw new AuthError('authentication required', 401);
        return deps.auth.sessionInfo(user);
      },
    }),
  ];
}
