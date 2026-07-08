import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuthUser } from '@companion/contract';

/**
 * Request-scoped context — the invoking user for the duration of one HTTP
 * request (and anything it awaits or fires off synchronously within it). Lets
 * deep resolvers (e.g. which GitHub account to act as) know who is acting
 * without threading the user through every service method. Work that runs
 * outside a request (automations, background sync, orchestrator-driven posts)
 * sees no user and falls back to the default account.
 */
const storage = new AsyncLocalStorage<{ readonly user: AuthUser | null }>();

/** Run `fn` with `user` as the invoking user for its async subtree. */
export function withRequestUser<T>(user: AuthUser | null, fn: () => T): T {
  return storage.run({ user }, fn);
}

/** The invoking user of the current request, or null outside one. */
export function currentUser(): AuthUser | null {
  return storage.getStore()?.user ?? null;
}
